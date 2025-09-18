const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api', limiter);

// Database connection
const dbConfig = {
    host: 'cashearnersofficial.xyz',
    user: 'cztldhwx_Auto_PostTg',
    password: 'Aptap786920',
    database: 'cztldhwx_Auto_PostTg',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

async function initDB() {
    try {
        pool = mysql.createPool(dbConfig);
        
        // Create tables if they don't exist
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                total_games INT DEFAULT 0,
                wins INT DEFAULT 0,
                losses INT DEFAULT 0,
                total_score INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS matches (
                id INT AUTO_INCREMENT PRIMARY KEY,
                player1_id INT,
                player2_id INT,
                player1_score INT DEFAULT 0,
                player2_score INT DEFAULT 0,
                winner_id INT,
                match_data JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (player1_id) REFERENCES users(id),
                FOREIGN KEY (player2_id) REFERENCES users(id),
                FOREIGN KEY (winner_id) REFERENCES users(id)
            )
        `);
        
        console.log('🗄️ Database connected and tables created');
    } catch (error) {
        console.error('❌ Database connection failed:', error);
    }
}

initDB();

// JWT Secret
const JWT_SECRET = 'your-super-secret-jwt-key-change-in-production';

// In-memory storage for game state
const gameRooms = new Map();
const waitingPlayers = new Map();
const playerSockets = new Map();

// Game Configuration
const GAME_CONFIG = {
    GAME_DURATION: 120000, // 2 minutes
    QUESTIONS_PER_GAME: 20,
    COUNTDOWN_DURATION: 5000
};

// Utility Functions
function generateMathQuestion() {
    const num1 = Math.floor(Math.random() * 90) + 10; // 10-99
    const num2 = Math.floor(Math.random() * 90) + 10; // 10-99
    const correctAnswer = num1 + num2;
    
    // Generate 3 wrong answers
    const wrongAnswers = [];
    while (wrongAnswers.length < 3) {
        const wrong = correctAnswer + Math.floor(Math.random() * 20) - 10;
        if (wrong !== correctAnswer && wrong > 0 && !wrongAnswers.includes(wrong)) {
            wrongAnswers.push(wrong);
        }
    }
    
    // Shuffle options
    const options = [correctAnswer, ...wrongAnswers].sort(() => Math.random() - 0.5);
    
    return {
        question: `${num1} + ${num2} = ?`,
        options: options,
        correctAnswer: correctAnswer,
        correctIndex: options.indexOf(correctAnswer)
    };
}

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

// API Routes
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// User registration/login
app.post('/api/login', async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username || username.length < 3 || username.length > 50) {
            return res.status(400).json({ error: 'Username must be 3-50 characters' });
        }
        
        // Check if user exists, create if not
        let [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        let user;
        
        if (rows.length === 0) {
            const [result] = await pool.execute(
                'INSERT INTO users (username) VALUES (?)', 
                [username]
            );
            user = { id: result.insertId, username, total_games: 0, wins: 0, losses: 0, total_score: 0 };
        } else {
            user = rows[0];
        }
        
        // Generate JWT token
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        
        res.json({ 
            success: true, 
            token, 
            user: {
                id: user.id,
                username: user.username,
                stats: {
                    total_games: user.total_games,
                    wins: user.wins,
                    losses: user.losses,
                    total_score: user.total_score
                }
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT username, total_games, wins, losses, total_score,
                   ROUND((wins / GREATEST(total_games, 1)) * 100, 1) as win_rate
            FROM users 
            WHERE total_games > 0
            ORDER BY total_score DESC, win_rate DESC 
            LIMIT 50
        `);
        
        res.json({ success: true, leaderboard: rows });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Socket.IO Authentication Middleware
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('No token provided'));
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.userId = decoded.userId;
        socket.username = decoded.username;
        next();
    } catch (error) {
        next(new Error('Invalid token'));
    }
});

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log(`🔌 ${socket.username} connected (${socket.id})`);
    playerSockets.set(socket.userId, socket);
    
    // Handle join queue
    socket.on('joinQueue', () => {
        // Remove from any existing games
        leaveAllGames(socket);
        
        // Check if already in queue
        if (waitingPlayers.has(socket.userId)) {
            socket.emit('error', 'Already in queue');
            return;
        }
        
        // Find waiting player
        const waitingPlayer = Array.from(waitingPlayers.values())[0];
        
        if (waitingPlayer && waitingPlayer.userId !== socket.userId) {
            // Match found!
            waitingPlayers.delete(waitingPlayer.userId);
            
            const roomId = generateRoomId();
            const gameRoom = {
                id: roomId,
                player1: { id: waitingPlayer.userId, username: waitingPlayer.username, score: 0, currentQuestion: null, answered: false },
                player2: { id: socket.userId, username: socket.username, score: 0, currentQuestion: null, answered: false },
                questions: [],
                startTime: null,
                endTime: null,
                currentQuestionIndex: 0,
                gameState: 'waiting' // waiting, countdown, playing, finished
            };
            
            gameRooms.set(roomId, gameRoom);
            
            // Join both players to room
            const player1Socket = playerSockets.get(waitingPlayer.userId);
            const player2Socket = playerSockets.get(socket.userId);
            
            if (player1Socket && player2Socket) {
                player1Socket.join(roomId);
                player2Socket.join(roomId);
                player1Socket.roomId = roomId;
                player2Socket.roomId = roomId;
                
                // Notify match found
                io.to(roomId).emit('matchFound', {
                    roomId,
                    player1: { username: gameRoom.player1.username },
                    player2: { username: gameRoom.player2.username }
                });
                
                // Start countdown
                setTimeout(() => startGame(roomId), GAME_CONFIG.COUNTDOWN_DURATION);
            }
        } else {
            // Add to waiting queue
            waitingPlayers.set(socket.userId, { userId: socket.userId, username: socket.username, socketId: socket.id });
            socket.emit('queueJoined', { message: 'Looking for opponent...' });
        }
    });
    
    // Handle leave queue
    socket.on('leaveQueue', () => {
        waitingPlayers.delete(socket.userId);
        socket.emit('queueLeft');
    });
    
    // Handle answer submission
    socket.on('submitAnswer', (data) => {
        const { answerIndex, timeSpent } = data;
        const roomId = socket.roomId;
        
        if (!roomId || !gameRooms.has(roomId)) {
            socket.emit('error', 'Game not found');
            return;
        }
        
        const gameRoom = gameRooms.get(roomId);
        if (gameRoom.gameState !== 'playing') {
            socket.emit('error', 'Game not active');
            return;
        }
        
        const isPlayer1 = gameRoom.player1.id === socket.userId;
        const player = isPlayer1 ? gameRoom.player1 : gameRoom.player2;
        
        // Check if player already answered current question
        if (player.answered) {
            socket.emit('error', 'Already answered this question');
            return;
        }
        
        // Validate answer
        const currentQuestion = player.currentQuestion;
        if (!currentQuestion) {
            socket.emit('error', 'No active question');
            return;
        }
        
        const isCorrect = answerIndex === currentQuestion.correctIndex;
        let points = 0;
        
        if (isCorrect) {
            // Calculate points based on time (faster = more points)
            const maxTime = 30000; // 30 seconds max per question
            const actualTime = Math.min(timeSpent || maxTime, maxTime);
            points = Math.max(10, Math.floor(100 - (actualTime / maxTime) * 50));
        }
        
        player.score += points;
        player.answered = true;
        
        // Send result to player
        socket.emit('answerResult', {
            correct: isCorrect,
            points: points,
            correctAnswer: currentQuestion.correctAnswer,
            yourScore: player.score
        });
        
        // Send next question to this player
        sendNextQuestion(roomId, socket.userId);
        
        // Update scores to room
        io.to(roomId).emit('scoreUpdate', {
            player1Score: gameRoom.player1.score,
            player2Score: gameRoom.player2.score
        });
    });
    
    // Handle WebRTC signaling
    socket.on('rtc-offer', (data) => {
        socket.to(socket.roomId).emit('rtc-offer', data);
    });
    
    socket.on('rtc-answer', (data) => {
        socket.to(socket.roomId).emit('rtc-answer', data);
    });
    
    socket.on('rtc-ice-candidate', (data) => {
        socket.to(socket.roomId).emit('rtc-ice-candidate', data);
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`🔌 ${socket.username} disconnected`);
        playerSockets.delete(socket.userId);
        waitingPlayers.delete(socket.userId);
        leaveAllGames(socket);
    });
});

// Game Functions
function startGame(roomId) {
    const gameRoom = gameRooms.get(roomId);
    if (!gameRoom) return;
    
    gameRoom.gameState = 'playing';
    gameRoom.startTime = Date.now();
    gameRoom.endTime = gameRoom.startTime + GAME_CONFIG.GAME_DURATION;
    
    // Generate questions for both players
    for (let i = 0; i < GAME_CONFIG.QUESTIONS_PER_GAME; i++) {
        gameRoom.questions.push(generateMathQuestion());
    }
    
    io.to(roomId).emit('gameStart', {
        duration: GAME_CONFIG.GAME_DURATION,
        startTime: gameRoom.startTime
    });
    
    // Send first question to both players
    sendNextQuestion(roomId, gameRoom.player1.id);
    sendNextQuestion(roomId, gameRoom.player2.id);
    
    // Set game end timer
    setTimeout(() => endGame(roomId), GAME_CONFIG.GAME_DURATION);
}

function sendNextQuestion(roomId, playerId) {
    const gameRoom = gameRooms.get(roomId);
    if (!gameRoom || gameRoom.gameState !== 'playing') return;
    
    const isPlayer1 = gameRoom.player1.id === playerId;
    const player = isPlayer1 ? gameRoom.player1 : gameRoom.player2;
    const socket = playerSockets.get(playerId);
    
    if (!socket || gameRoom.currentQuestionIndex >= gameRoom.questions.length) return;
    
    const question = gameRoom.questions[gameRoom.currentQuestionIndex];
    player.currentQuestion = question;
    player.answered = false;
    
    socket.emit('newQuestion', {
        question: question.question,
        options: question.options,
        questionNumber: gameRoom.currentQuestionIndex + 1,
        totalQuestions: GAME_CONFIG.QUESTIONS_PER_GAME
    });
    
    gameRoom.currentQuestionIndex++;
}

async function endGame(roomId) {
    const gameRoom = gameRooms.get(roomId);
    if (!gameRoom) return;
    
    gameRoom.gameState = 'finished';
    
    const player1 = gameRoom.player1;
    const player2 = gameRoom.player2;
    
    // Determine winner
    let winner = null;
    if (player1.score > player2.score) {
        winner = player1;
    } else if (player2.score > player1.score) {
        winner = player2;
    }
    
    // Save match to database
    try {
        const [result] = await pool.execute(
            'INSERT INTO matches (player1_id, player2_id, player1_score, player2_score, winner_id, match_data) VALUES (?, ?, ?, ?, ?, ?)',
            [
                player1.id, 
                player2.id, 
                player1.score, 
                player2.score, 
                winner ? winner.id : null,
                JSON.stringify({
                    duration: GAME_CONFIG.GAME_DURATION,
                    questionsAnswered: gameRoom.currentQuestionIndex
                })
            ]
        );
        
        // Update user stats
        await pool.execute(
            'UPDATE users SET total_games = total_games + 1, total_score = total_score + ?, wins = wins + ?, losses = losses + ? WHERE id = ?',
            [player1.score, winner && winner.id === player1.id ? 1 : 0, winner && winner.id !== player1.id ? 1 : 0, player1.id]
        );
        
        await pool.execute(
            'UPDATE users SET total_games = total_games + 1, total_score = total_score + ?, wins = wins + ?, losses = losses + ? WHERE id = ?',
            [player2.score, winner && winner.id === player2.id ? 1 : 0, winner && winner.id !== player2.id ? 1 : 0, player2.id]
        );
        
    } catch (error) {
        console.error('Error saving match:', error);
    }
    
    // Send results
    io.to(roomId).emit('gameEnd', {
        player1: { username: player1.username, score: player1.score },
        player2: { username: player2.username, score: player2.score },
        winner: winner ? winner.username : 'Draw',
        matchId: result ? result.insertId : null
    });
    
    // Cleanup
    setTimeout(() => {
        gameRooms.delete(roomId);
        
        // Remove room references from sockets
        const p1Socket = playerSockets.get(player1.id);
        const p2Socket = playerSockets.get(player2.id);
        
        if (p1Socket) {
            p1Socket.leave(roomId);
            delete p1Socket.roomId;
        }
        if (p2Socket) {
            p2Socket.leave(roomId);
            delete p2Socket.roomId;
        }
    }, 10000); // Keep room for 10 seconds for final messages
}

function leaveAllGames(socket) {
    waitingPlayers.delete(socket.userId);
    
    if (socket.roomId) {
        const gameRoom = gameRooms.get(socket.roomId);
        if (gameRoom) {
            // Notify other player
            socket.to(socket.roomId).emit('playerDisconnected', {
                message: 'Your opponent has disconnected'
            });
            
            // End game if in progress
            if (gameRoom.gameState === 'playing') {
                endGame(socket.roomId);
            }
        }
        
        socket.leave(socket.roomId);
        delete socket.roomId;
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Math Battle Server running on port ${PORT}`);
    console.log(`🎮 Game Duration: ${GAME_CONFIG.GAME_DURATION / 1000} seconds`);
    console.log(`❓ Questions per game: ${GAME_CONFIG.QUESTIONS_PER_GAME}`);
});
