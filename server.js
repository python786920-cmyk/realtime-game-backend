// ===================================
// COMPLETE BACKEND - REAL-TIME BATTLE GAME
// Render.com Ready | Node.js + Express + Socket.IO
// ===================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// CORS Configuration
const io = socketIo(server, {
    cors: {
        origin: "*", // Your frontend domain
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// ===================================
// GAME DATA STRUCTURES
// ===================================

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = new Map();
        this.gameState = 'waiting'; // waiting, countdown, playing, finished
        this.currentQuestion = null;
        this.gameStartTime = null;
        this.gameEndTime = null;
        this.gameDuration = 120000; // 2 minutes in milliseconds
        this.questionIndex = 0;
        this.playerAnswers = new Map();
    }

    addPlayer(socketId, username) {
        if (this.players.size >= 2) return false;
        
        this.players.set(socketId, {
            id: socketId,
            username: username,
            score: 0,
            currentQuestion: null,
            answered: false,
            joinTime: Date.now(),
            isReady: false
        });
        return true;
    }

    removePlayer(socketId) {
        this.players.delete(socketId);
    }

    getPlayer(socketId) {
        return this.players.get(socketId);
    }

    getAllPlayers() {
        return Array.from(this.players.values());
    }

    isRoomFull() {
        return this.players.size === 2;
    }

    isEmpty() {
        return this.players.size === 0;
    }

    startGame() {
        this.gameState = 'playing';
        this.gameStartTime = Date.now();
        this.gameEndTime = this.gameStartTime + this.gameDuration;
        this.sendNextQuestionToAllPlayers();
    }

    sendNextQuestionToAllPlayers() {
        const question = this.generateQuestion();
        this.currentQuestion = question;
        this.questionIndex++;
        
        // Reset answered status for all players
        this.players.forEach(player => {
            player.answered = false;
            player.currentQuestion = question;
        });
        
        // Clear previous answers
        this.playerAnswers.clear();
        
        return question;
    }

    generateQuestion() {
        const operations = ['+', '-', '*'];
        const operation = operations[Math.floor(Math.random() * operations.length)];
        
        let num1, num2, correctAnswer;
        
        switch(operation) {
            case '+':
                num1 = Math.floor(Math.random() * 100) + 1;
                num2 = Math.floor(Math.random() * 100) + 1;
                correctAnswer = num1 + num2;
                break;
            case '-':
                num1 = Math.floor(Math.random() * 100) + 50;
                num2 = Math.floor(Math.random() * 50) + 1;
                correctAnswer = num1 - num2;
                break;
            case '*':
                num1 = Math.floor(Math.random() * 12) + 1;
                num2 = Math.floor(Math.random() * 12) + 1;
                correctAnswer = num1 * num2;
                break;
        }

        // Generate 3 wrong options
        const wrongOptions = [];
        while (wrongOptions.length < 3) {
            const wrongAnswer = correctAnswer + (Math.floor(Math.random() * 20) - 10);
            if (wrongAnswer !== correctAnswer && !wrongOptions.includes(wrongAnswer) && wrongAnswer > 0) {
                wrongOptions.push(wrongAnswer);
            }
        }

        // Mix correct answer with wrong options
        const options = [...wrongOptions, correctAnswer];
        
        // Shuffle options
        for (let i = options.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [options[i], options[j]] = [options[j], options[i]];
        }

        return {
            id: this.questionIndex,
            question: `${num1} ${operation} ${num2} = ?`,
            options: options,
            correctAnswer: correctAnswer,
            timeStamp: Date.now()
        };
    }

    submitAnswer(socketId, answer) {
        const player = this.getPlayer(socketId);
        if (!player || player.answered) return false;

        const isCorrect = answer === this.currentQuestion.correctAnswer;
        
        if (isCorrect) {
            player.score += 1;
        }

        player.answered = true;
        this.playerAnswers.set(socketId, {
            answer: answer,
            isCorrect: isCorrect,
            timestamp: Date.now()
        });

        return { isCorrect, correctAnswer: this.currentQuestion.correctAnswer };
    }

    checkIfAllAnswered() {
        return Array.from(this.players.values()).every(player => player.answered);
    }

    isGameTimeUp() {
        if (!this.gameEndTime) return false;
        return Date.now() >= this.gameEndTime;
    }

    getGameResult() {
        const players = this.getAllPlayers().sort((a, b) => b.score - a.score);
        return {
            winner: players[0]?.score > players[1]?.score ? players[0] : null,
            players: players,
            gameEndTime: Date.now()
        };
    }

    getRemainingTime() {
        if (!this.gameEndTime) return 0;
        return Math.max(0, this.gameEndTime - Date.now());
    }
}

// ===================================
// GLOBAL GAME STATE
// ===================================

const gameRooms = new Map();
const waitingQueue = [];
const playerSocketMap = new Map(); // socketId -> roomId

// ===================================
// UTILITY FUNCTIONS
// ===================================

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

function findOrCreateRoom() {
    // Find existing room with space
    for (let [roomId, room] of gameRooms) {
        if (!room.isRoomFull() && room.gameState === 'waiting') {
            return room;
        }
    }
    
    // Create new room
    const roomId = generateRoomId();
    const newRoom = new GameRoom(roomId);
    gameRooms.set(roomId, newRoom);
    return newRoom;
}

function removePlayerFromQueue(socketId) {
    const index = waitingQueue.findIndex(player => player.socketId === socketId);
    if (index !== -1) {
        waitingQueue.splice(index, 1);
    }
}

function cleanupRoom(roomId) {
    const room = gameRooms.get(roomId);
    if (room && room.isEmpty()) {
        gameRooms.delete(roomId);
        console.log(`Room ${roomId} cleaned up`);
    }
}

// ===================================
// SOCKET.IO CONNECTION HANDLING
// ===================================

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    // ===================================
    // JOIN QUEUE FOR MATCHMAKING
    // ===================================
    socket.on('joinQueue', (data) => {
        const { username } = data;
        console.log(`${username} (${socket.id}) joined queue`);
        
        // Remove from any existing queue
        removePlayerFromQueue(socket.id);
        
        // Add to waiting queue
        waitingQueue.push({
            socketId: socket.id,
            username: username || `Player_${socket.id.substr(0, 6)}`,
            joinTime: Date.now()
        });

        socket.emit('queueJoined', {
            status: 'waiting',
            queuePosition: waitingQueue.length,
            message: 'Looking for opponent...'
        });

        // Try to match players
        if (waitingQueue.length >= 2) {
            const player1 = waitingQueue.shift();
            const player2 = waitingQueue.shift();
            
            const room = findOrCreateRoom();
            
            // Add players to room
            room.addPlayer(player1.socketId, player1.username);
            room.addPlayer(player2.socketId, player2.username);
            
            // Map players to room
            playerSocketMap.set(player1.socketId, room.id);
            playerSocketMap.set(player2.socketId, room.id);
            
            // Join socket rooms
            io.sockets.sockets.get(player1.socketId)?.join(room.id);
            io.sockets.sockets.get(player2.socketId)?.join(room.id);
            
            // Notify players about match found
            io.to(room.id).emit('matchFound', {
                roomId: room.id,
                players: room.getAllPlayers(),
                countdown: 5
            });
            
            console.log(`Match created: ${player1.username} vs ${player2.username} in room ${room.id}`);
            
            // Start countdown
            let countdown = 5;
            const countdownInterval = setInterval(() => {
                countdown--;
                io.to(room.id).emit('countdownUpdate', { countdown });
                
                if (countdown <= 0) {
                    clearInterval(countdownInterval);
                    room.startGame();
                    
                    const question = room.currentQuestion;
                    io.to(room.id).emit('gameStart', {
                        question: question,
                        gameTime: room.gameDuration,
                        players: room.getAllPlayers()
                    });
                    
                    // Start game timer
                    const gameTimer = setInterval(() => {
                        if (room.isGameTimeUp()) {
                            clearInterval(gameTimer);
                            endGame(room.id);
                        } else {
                            io.to(room.id).emit('timeUpdate', {
                                remainingTime: room.getRemainingTime()
                            });
                        }
                    }, 1000);
                }
            }, 1000);
        }
    });

    // ===================================
    // SUBMIT ANSWER
    // ===================================
    socket.on('submitAnswer', (data) => {
        const { answer } = data;
        const roomId = playerSocketMap.get(socket.id);
        const room = gameRooms.get(roomId);
        
        if (!room || room.gameState !== 'playing') {
            socket.emit('error', { message: 'Invalid game state' });
            return;
        }

        const result = room.submitAnswer(socket.id, answer);
        if (!result) {
            socket.emit('error', { message: 'Already answered or invalid player' });
            return;
        }

        const player = room.getPlayer(socket.id);
        
        // Send individual result to player
        socket.emit('answerResult', {
            isCorrect: result.isCorrect,
            correctAnswer: result.correctAnswer,
            yourAnswer: answer,
            newScore: player.score
        });

        // Update scoreboard for all players in room
        io.to(roomId).emit('scoreUpdate', {
            players: room.getAllPlayers().map(p => ({
                id: p.id,
                username: p.username,
                score: p.score,
                answered: p.answered
            }))
        });

        // Check if player needs next question
        setTimeout(() => {
            if (!room.isGameTimeUp()) {
                const nextQuestion = room.sendNextQuestionToAllPlayers();
                
                // Send next question to this player
                socket.emit('nextQuestion', {
                    question: nextQuestion,
                    remainingTime: room.getRemainingTime()
                });
                
                // Send next question to opponent too
                room.players.forEach((player, playerId) => {
                    if (playerId !== socket.id) {
                        io.to(playerId).emit('nextQuestion', {
                            question: nextQuestion,
                            remainingTime: room.getRemainingTime()
                        });
                    }
                });
            }
        }, 1500); // 1.5 second delay before next question
    });

    // ===================================
    // VOICE CHAT - WebRTC SIGNALING
    // ===================================
    socket.on('voiceOffer', (data) => {
        const roomId = playerSocketMap.get(socket.id);
        socket.to(roomId).emit('voiceOffer', {
            offer: data.offer,
            from: socket.id
        });
    });

    socket.on('voiceAnswer', (data) => {
        const roomId = playerSocketMap.get(socket.id);
        socket.to(roomId).emit('voiceAnswer', {
            answer: data.answer,
            from: socket.id
        });
    });

    socket.on('iceCandidate', (data) => {
        const roomId = playerSocketMap.get(socket.id);
        socket.to(roomId).emit('iceCandidate', {
            candidate: data.candidate,
            from: socket.id
        });
    });

    // ===================================
    // DISCONNECT HANDLING
    // ===================================
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        
        // Remove from queue
        removePlayerFromQueue(socket.id);
        
        // Handle room cleanup
        const roomId = playerSocketMap.get(socket.id);
        if (roomId) {
            const room = gameRooms.get(roomId);
            if (room) {
                room.removePlayer(socket.id);
                
                // Notify other players in room
                socket.to(roomId).emit('opponentDisconnected', {
                    message: 'Your opponent has disconnected'
                });
                
                // Cleanup room if empty
                cleanupRoom(roomId);
            }
            playerSocketMap.delete(socket.id);
        }
    });

    // ===================================
    // READY STATE
    // ===================================
    socket.on('playerReady', () => {
        const roomId = playerSocketMap.get(socket.id);
        const room = gameRooms.get(roomId);
        
        if (room) {
            const player = room.getPlayer(socket.id);
            if (player) {
                player.isReady = true;
                
                io.to(roomId).emit('playerReadyUpdate', {
                    players: room.getAllPlayers()
                });
            }
        }
    });
});

// ===================================
// GAME END FUNCTION
// ===================================
function endGame(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;
    
    room.gameState = 'finished';
    const result = room.getGameResult();
    
    io.to(roomId).emit('gameEnd', {
        result: result,
        finalScores: result.players,
        winner: result.winner,
        gameStats: {
            totalQuestions: room.questionIndex,
            gameDuration: room.gameDuration,
            playersData: result.players
        }
    });
    
    // Cleanup after 30 seconds
    setTimeout(() => {
        room.players.forEach((player, socketId) => {
            playerSocketMap.delete(socketId);
        });
        cleanupRoom(roomId);
    }, 30000);
}

// ===================================
// REST API ENDPOINTS
// ===================================

app.get('/', (req, res) => {
    res.json({
        status: 'Real-time Battle Game Server Running',
        version: '1.0.0',
        activeRooms: gameRooms.size,
        playersInQueue: waitingQueue.length,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/stats', (req, res) => {
    res.json({
        activeRooms: gameRooms.size,
        playersInQueue: waitingQueue.length,
        totalConnectedPlayers: io.engine.clientsCount,
        serverUptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ===================================
// ERROR HANDLING
// ===================================
process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.log('Uncaught Exception:', error);
    process.exit(1);
});

// ===================================
// SERVER START
// ===================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 Real-time Battle Game Server running on port ${PORT}`);
    console.log(`📊 Server started at: ${new Date().toISOString()}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// ===================================
// PERIODIC CLEANUP
// ===================================
setInterval(() => {
    // Clean up empty rooms
    gameRooms.forEach((room, roomId) => {
        if (room.isEmpty()) {
            cleanupRoom(roomId);
        }
    });
    
    // Clean up stale queue entries (older than 5 minutes)
    const now = Date.now();
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
        if (now - waitingQueue[i].joinTime > 300000) { // 5 minutes
            waitingQueue.splice(i, 1);
        }
    }
}, 60000); // Run every minute

module.exports = { app, server, io };
