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
        origin: "*", // Replace with your frontend domain in production
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
    
    // Generate 3 unique wrong answers
    const wrongAnswers = new Set();
    while (wrongAnswers.size < 3) {
        const wrong = correctAnswer + Math.floor(Math.random() * 20) - 10;
        if (wrong !== correctAnswer && wrong > 0) {
            wrongAnswers.add(wrong);
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
        options,
        correctAnswer,
        questionNumber: 1 // Will be updated when sent
    };
}

// Generate question sequence for a room
function generateQuestionSequence(count = 50) {
    return Array.from({ length: count }, (_, i) => ({
        ...generateQuestion(),
        questionNumber: i + 1
    }));
}

// Create new room
function createRoom(player1, player2) {
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const room = {
        id: roomId,
        players: [
            { socketId: player1.id, username: player1.username, score: 0, currentQuestion: 1, isConnected: true },
            { socketId: player2.id, username: player2.username, score: 0, currentQuestion: 1, isConnected: true }
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
        io.to(roomId).emit('timeUpdate', { timeLeft: room.timer });
        
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
    if (room.timerInterval) clearInterval(room.timerInterval);
    
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
    
    io.to(roomId).emit('gameOver', {
        result,
        finalScores: {
            [player1.username]: player1.score,
            [player2.username]: player2.score
        }
    });
    
    // Clean up room after 30 seconds
    setTimeout(() => cleanupRoom(roomId), 30000);
}

// Clean up room
function cleanupRoom(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) return;
    
    if (room.timerInterval) clearInterval(room.timerInterval);
    
    room.players.forEach(player => playerRooms.delete(player.socketId));
    activeRooms.delete(roomId);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    socket.on('joinQueue', (data) => {
        const player = {
            id: socket.id,
            username: data.username || `Guest_${socket.id.substr(0, 6)}`,
            socket
        };
        
        if (waitingQueue.length > 0) {
            const opponent = waitingQueue.shift();
            const room = createRoom(opponent, player);
            
            io.to(room.id).emit('matchFound', {
                roomId: room.id,
                opponent: {
                    [opponent.id]: player.username,
                    [player.id]: opponent.username
                },
                countdown: 5
            });
            
            setTimeout(() => {
                if (activeRooms.has(room.id)) {
                    room.gameStarted = true;
                    startGameTimer(room.id);
                    
                    io.to(room.id).emit('gameStart', {
                        message: 'Game Started!',
                        timer: room.timer
                    });
                    
                    io.to(room.id).emit('newQuestion', room.questions[0]);
                }
            }, 5000);
        } else {
            waitingQueue.push(player);
            socket.emit('waitingForOpponent', { 
                message: 'Looking for opponent...',
                position: waitingQueue.length 
            });
        }
    });
    
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
        
        if (isCorrect) player.score++;
        
        socket.emit('answerResult', {
            correct: isCorrect,
            correctAnswer: question.correctAnswer,
            yourAnswer: data.answer
        });
        
        const scoreUpdate = {};
        room.players.forEach(p => {
            scoreUpdate[p.username] = p.score;
        });
        
        io.to(roomId).emit('updateScore', scoreUpdate);
        
        player.currentQuestion++;
        
        const nextQuestionIndex = player.currentQuestion - 1;
        if (nextQuestionIndex < room.questions.length) {
            socket.emit('newQuestion', room.questions[nextQuestionIndex]);
        } else {
            socket.emit('noMoreQuestions', { message: 'No more questions available!' });
        }
    });
    
    // WebRTC Signaling
    socket.on('webrtcOffer', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) socket.to(roomId).emit('webrtcOffer', { offer: data.offer, from: socket.id });
    });
    
    socket.on('webrtcAnswer', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) socket.to(roomId).emit('webrtcAnswer', { answer: data.answer, from: socket.id });
    });
    
    socket.on('webrtcIce', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) socket.to(roomId).emit('webrtcIce', { ice: data.ice, from: socket.id });
    });
    
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
        if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1);
        
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const room = activeRooms.get(roomId);
            if (room) {
                const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
                if (playerIndex !== -1) {
                    room.players[playerIndex].isConnected = false;
                    socket.to(roomId).emit('opponentDisconnected', { message: 'Opponent disconnected' });
                    if (room.gameStarted && !room.gameEnded) endGame(roomId);
                }
            }
        }
    });
    
    socket.on('leaveGame', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('opponentLeft', { message: 'Opponent left the game' });
            const room = activeRooms.get(roomId);
            if (room && !room.gameEnded) endGame(roomId);
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

// Cleanup inactive rooms
setInterval(() => {
    const now = Date.now();
    const roomsToDelete = [];
    
    activeRooms.forEach((room, roomId) => {
        const roomAge = now - room.createdAt;
        if (roomAge > 600000 || (room.gameEnded && roomAge > 120000)) {
            roomsToDelete.push(roomId);
        }
    });
    
    roomsToDelete.forEach(cleanupRoom);
    console.log(`Cleaned up ${roomsToDelete.length} inactive rooms`);
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Math Quiz Game Server running on port ${PORT}`);
    console.log(`🎮 Game features: Matchmaking, Voice Chat, Real-time Quiz`);
});
