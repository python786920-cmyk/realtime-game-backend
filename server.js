// server.js - Complete Backend for Math Quiz Game
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS configuration for frontend connection
const io = socketIo(server, {
    cors: {
        origin: "https://cashearnersofficial.xyz", // Replace with your frontend domain in production
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Global variables
let waitingQueue = []; // Players waiting for match
let activeRooms = new Map(); // roomId -> room data
let playerRooms = new Map(); // socketId -> roomId

// Question Generator
function generateQuestion() {
    const a = Math.floor(Math.random() * 50) + 1;
    const b = Math.floor(Math.random() * 50) + 1;
    const correctAnswer = a + b;
    
    // Generate 3 wrong answers
    const wrongAnswers = [];
    while (wrongAnswers.length < 3) {
        const wrong = correctAnswer + Math.floor(Math.random() * 20) - 10;
        if (wrong !== correctAnswer && wrong > 0 && !wrongAnswers.includes(wrong)) {
            wrongAnswers.push(wrong);
        }
    }
    
    // Combine and shuffle options
    const options = [correctAnswer, ...wrongAnswers];
    for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
    }
    
    return {
        question: `${a} + ${b} = ?`,
        options: options,
        correctAnswer: correctAnswer,
        questionNumber: 1 // Will be updated when sent
    };
}

// Generate question sequence for a room
function generateQuestionSequence(count = 50) {
    const questions = [];
    for (let i = 0; i < count; i++) {
        const q = generateQuestion();
        q.questionNumber = i + 1;
        questions.push(q);
    }
    return questions;
}

// Create new room
function createRoom(player1, player2) {
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const room = {
        id: roomId,
        players: [
            {
                socketId: player1.id,
                username: player1.username,
                score: 0,
                currentQuestion: 1,
                isConnected: true
            },
            {
                socketId: player2.id,
                username: player2.username,
                score: 0,
                currentQuestion: 1,
                isConnected: true
            }
        ],
        questions: generateQuestionSequence(),
        gameStarted: false,
        gameEnded: false,
        timer: 120, // 2 minutes in seconds
        timerInterval: null,
        createdAt: Date.now()
    };
    
    activeRooms.set(roomId, room);
    playerRooms.set(player1.id, roomId);
    playerRooms.set(player2.id, roomId);
    
    // Join socket rooms
    player1.socket.join(roomId);
    player2.socket.join(roomId);
    
    return room;
}

// Start game timer
function startGameTimer(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) return;
    
    room.timerInterval = setInterval(() => {
        room.timer--;
        
        // Send timer update to both players
        io.to(roomId).emit('timeUpdate', { timeLeft: room.timer });
        
        // Game over when timer reaches 0
        if (room.timer <= 0) {
            endGame(roomId);
        }
    }, 1000);
}

// End game
function endGame(roomId) {
    const room = activeRooms.get(roomId);
    if (!room || room.gameEnded) return;
    
    room.gameEnded = true;
    if (room.timerInterval) {
        clearInterval(room.timerInterval);
    }
    
    const [player1, player2] = room.players;
    let result;
    
    if (player1.score > player2.score) {
        result = {
            winner: player1.username,
            loser: player2.username,
            winnerScore: player1.score,
            loserScore: player2.score,
            isDraw: false
        };
    } else if (player2.score > player1.score) {
        result = {
            winner: player2.username,
            loser: player1.username,
            winnerScore: player2.score,
            loserScore: player1.score,
            isDraw: false
        };
    } else {
        result = {
            winner: null,
            loser: null,
            winnerScore: player1.score,
            loserScore: player2.score,
            isDraw: true
        };
    }
    
    // Send game over event to both players
    io.to(roomId).emit('gameOver', {
        result: result,
        finalScores: {
            [player1.username]: player1.score,
            [player2.username]: player2.score
        }
    });
    
    // Clean up room after 30 seconds
    setTimeout(() => {
        cleanupRoom(roomId);
    }, 30000);
}

// Clean up room
function cleanupRoom(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) return;
    
    if (room.timerInterval) {
        clearInterval(room.timerInterval);
    }
    
    room.players.forEach(player => {
        playerRooms.delete(player.socketId);
    });
    
    activeRooms.delete(roomId);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    // Join queue for matchmaking
    socket.on('joinQueue', (data) => {
        const { username } = data;
        const player = {
            id: socket.id,
            username: username || `Guest_${socket.id.substr(0, 6)}`,
            socket: socket
        };
        
        // Check if someone is already waiting
        if (waitingQueue.length > 0) {
            const opponent = waitingQueue.shift();
            
            // Create room and match players
            const room = createRoom(opponent, player);
            
            // Notify both players about match found
            io.to(room.id).emit('matchFound', {
                roomId: room.id,
                opponent: {
                    [opponent.id]: player.username,
                    [player.id]: opponent.username
                },
                countdown: 5
            });
            
            // Start countdown then game
            setTimeout(() => {
                if (activeRooms.has(room.id)) {
                    room.gameStarted = true;
                    startGameTimer(room.id);
                    
                    // Send game start event
                    io.to(room.id).emit('gameStart', {
                        message: 'Game Started!',
                        timer: room.timer
                    });
                    
                    // Send first question to both players
                    const firstQuestion = room.questions[0];
                    io.to(room.id).emit('newQuestion', firstQuestion);
                }
            }, 5000);
            
        } else {
            // Add to waiting queue
            waitingQueue.push(player);
            socket.emit('waitingForOpponent', { 
                message: 'Looking for opponent...',
                position: waitingQueue.length 
            });
        }
    });
    
    // Handle answer submission
    socket.on('submitAnswer', (data) => {
        const roomId = playerRooms.get(socket.id);
        const room = activeRooms.get(roomId);
        
        if (!room || room.gameEnded) return;
        
        const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex === -1) return;
        
        const player = room.players[playerIndex];
        const currentQuestionIndex = player.currentQuestion - 1;
        
        if (currentQuestionIndex >= room.questions.length) return;
        
        const question = room.questions[currentQuestionIndex];
        const isCorrect = data.answer === question.correctAnswer;
        
        // Update score if correct
        if (isCorrect) {
            player.score++;
        }
        
        // Send answer result to the player
        socket.emit('answerResult', {
            correct: isCorrect,
            correctAnswer: question.correctAnswer,
            yourAnswer: data.answer
        });
        
        // Update scoreboard for both players
        const scoreUpdate = {};
        room.players.forEach(p => {
            scoreUpdate[p.username] = p.score;
        });
        
        io.to(roomId).emit('updateScore', scoreUpdate);
        
        // Move to next question for this player
        player.currentQuestion++;
        
        // Send next question to this player only
        const nextQuestionIndex = player.currentQuestion - 1;
        if (nextQuestionIndex < room.questions.length) {
            const nextQuestion = room.questions[nextQuestionIndex];
            socket.emit('newQuestion', nextQuestion);
        } else {
            socket.emit('noMoreQuestions', { message: 'No more questions available!' });
        }
    });
    
    // WebRTC Signaling for Voice Chat
    socket.on('webrtcOffer', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('webrtcOffer', {
                offer: data.offer,
                from: socket.id
            });
        }
    });
    
    socket.on('webrtcAnswer', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('webrtcAnswer', {
                answer: data.answer,
                from: socket.id
            });
        }
    });
    
    socket.on('webrtcIce', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('webrtcIce', {
                ice: data.ice,
                from: socket.id
            });
        }
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        // Remove from waiting queue if present
        const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
        if (queueIndex !== -1) {
            waitingQueue.splice(queueIndex, 1);
        }
        
        // Handle room disconnection
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const room = activeRooms.get(roomId);
            if (room) {
                const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
                if (playerIndex !== -1) {
                    room.players[playerIndex].isConnected = false;
                    
                    // Notify other player about disconnection
                    socket.to(roomId).emit('opponentDisconnected', {
                        message: 'Opponent disconnected'
                    });
                    
                    // End game if both players disconnected or game is active
                    if (room.gameStarted && !room.gameEnded) {
                        endGame(roomId);
                    }
                }
            }
        }
    });
    
    // Handle leave game
    socket.on('leaveGame', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('opponentLeft', {
                message: 'Opponent left the game'
            });
            
            const room = activeRooms.get(roomId);
            if (room && !room.gameEnded) {
                endGame(roomId);
            }
        }
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'Math Quiz Game Server Running',
        timestamp: new Date().toISOString(),
        activeRooms: activeRooms.size,
        waitingPlayers: waitingQueue.length
    });
});

// Stats endpoint
app.get('/stats', (req, res) => {
    res.json({
        activeRooms: activeRooms.size,
        waitingPlayers: waitingQueue.length,
        totalConnections: io.engine.clientsCount
    });
});

// Cleanup inactive rooms every 5 minutes
setInterval(() => {
    const now = Date.now();
    const roomsToDelete = [];
    
    activeRooms.forEach((room, roomId) => {
        // Remove rooms older than 10 minutes or completed games older than 2 minutes
        const roomAge = now - room.createdAt;
        if (roomAge > 600000 || (room.gameEnded && roomAge > 120000)) {
            roomsToDelete.push(roomId);
        }
    });
    
    roomsToDelete.forEach(roomId => {
        cleanupRoom(roomId);
    });
    
    console.log(`Cleaned up ${roomsToDelete.length} inactive rooms`);
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Math Quiz Game Server running on port ${PORT}`);
    console.log(`🎮 Game features: Matchmaking, Voice Chat, Real-time Quiz`);
});
