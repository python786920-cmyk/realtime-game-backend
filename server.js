const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS configuration
app.use(cors({
    origin: "*", // Allow all origins - adjust for production
    methods: ["GET", "POST"]
}));

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

// Game State Management
const waitingQueue = [];
const activeRooms = new Map();
const userSockets = new Map();

// Math Questions Generator
function generateMathQuestion() {
    const operations = ['+', '-', '*'];
    const operation = operations[Math.floor(Math.random() * operations.length)];
    
    let num1, num2, correctAnswer;
    
    switch(operation) {
        case '+':
            num1 = Math.floor(Math.random() * 50) + 10;
            num2 = Math.floor(Math.random() * 50) + 10;
            correctAnswer = num1 + num2;
            break;
        case '-':
            num1 = Math.floor(Math.random() * 50) + 30;
            num2 = Math.floor(Math.random() * 20) + 5;
            correctAnswer = num1 - num2;
            break;
        case '*':
            num1 = Math.floor(Math.random() * 10) + 2;
            num2 = Math.floor(Math.random() * 10) + 2;
            correctAnswer = num1 * num2;
            break;
    }
    
    const question = `${num1} ${operation} ${num2} = ?`;
    
    // Generate wrong options
    const options = [correctAnswer];
    while(options.length < 4) {
        let wrongAnswer;
        if(operation === '*') {
            wrongAnswer = correctAnswer + Math.floor(Math.random() * 20) - 10;
        } else {
            wrongAnswer = correctAnswer + Math.floor(Math.random() * 30) - 15;
        }
        
        if(wrongAnswer > 0 && !options.includes(wrongAnswer)) {
            options.push(wrongAnswer);
        }
    }
    
    // Shuffle options
    for(let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
    }
    
    return {
        question,
        options,
        correctAnswer,
        correctIndex: options.indexOf(correctAnswer)
    };
}

// Room Management
class GameRoom {
    constructor(player1, player2) {
        this.id = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.players = [
            { socket: player1, score: 0, answered: false },
            { socket: player2, score: 0, answered: false }
        ];
        this.currentQuestion = null;
        this.gameTimer = null;
        this.questionTimer = null;
        this.gameStartTime = null;
        this.gameActive = false;
        this.questionsAsked = 0;
    }
    
    startGame() {
        this.gameActive = true;
        this.gameStartTime = Date.now();
        
        // Join both players to room
        this.players.forEach(player => {
            player.socket.join(this.id);
        });
        
        // Send game start event
        io.to(this.id).emit('gameStarted', {
            roomId: this.id,
            players: this.players.length
        });
        
        // Start first question after 1 second
        setTimeout(() => {
            this.sendNextQuestion();
        }, 1000);
        
        // Set main game timer (2 minutes)
        this.gameTimer = setTimeout(() => {
            this.endGame();
        }, 120000); // 2 minutes
    }
    
    sendNextQuestion() {
        if(!this.gameActive) return;
        
        this.currentQuestion = generateMathQuestion();
        this.questionsAsked++;
        
        // Reset answered status
        this.players.forEach(player => {
            player.answered = false;
        });
        
        // Send question to both players
        io.to(this.id).emit('newQuestion', {
            questionNumber: this.questionsAsked,
            question: this.currentQuestion.question,
            options: this.currentQuestion.options,
            timeLeft: Math.max(0, 120 - Math.floor((Date.now() - this.gameStartTime) / 1000))
        });
        
        // Auto next question after 8 seconds
        this.questionTimer = setTimeout(() => {
            if(this.gameActive) {
                this.sendNextQuestion();
            }
        }, 8000);
    }
    
    handleAnswer(socket, answerIndex) {
        if(!this.gameActive || !this.currentQuestion) return;
        
        const player = this.players.find(p => p.socket.id === socket.id);
        if(!player || player.answered) return;
        
        player.answered = true;
        
        // Check if answer is correct
        const isCorrect = answerIndex === this.currentQuestion.correctIndex;
        if(isCorrect) {
            player.score += 1;
        }
        
        // Send answer result to player
        socket.emit('answerResult', {
            correct: isCorrect,
            correctAnswer: this.currentQuestion.correctIndex,
            yourScore: player.score
        });
        
        // Update scoreboard for both players
        io.to(this.id).emit('scoreUpdate', {
            scores: this.players.map((p, index) => ({
                player: `Player ${index + 1}`,
                score: p.score
            }))
        });
        
        // If both answered, send next question immediately
        if(this.players.every(p => p.answered)) {
            clearTimeout(this.questionTimer);
            setTimeout(() => {
                this.sendNextQuestion();
            }, 2000);
        }
    }
    
    endGame() {
        if(!this.gameActive) return;
        
        this.gameActive = false;
        clearTimeout(this.gameTimer);
        clearTimeout(this.questionTimer);
        
        // Determine winner
        const scores = this.players.map(p => p.score);
        const maxScore = Math.max(...scores);
        const winners = this.players.filter(p => p.score === maxScore);
        
        let result;
        if(winners.length > 1) {
            result = { type: 'tie', score: maxScore };
        } else {
            result = { 
                type: 'winner', 
                winnerId: winners[0].socket.id, 
                score: maxScore 
            };
        }
        
        // Send final results
        io.to(this.id).emit('gameEnded', {
            result,
            finalScores: this.players.map((p, index) => ({
                player: `Player ${index + 1}`,
                score: p.score,
                isYou: false // Will be set by client
            })),
            totalQuestions: this.questionsAsked
        });
        
        // Cleanup
        setTimeout(() => {
            this.cleanup();
        }, 10000);
    }
    
    cleanup() {
        this.players.forEach(player => {
            player.socket.leave(this.id);
        });
        activeRooms.delete(this.id);
    }
    
    removePlayer(socket) {
        const playerIndex = this.players.findIndex(p => p.socket.id === socket.id);
        if(playerIndex !== -1) {
            this.players.splice(playerIndex, 1);
            
            if(this.players.length === 0) {
                this.cleanup();
            } else if(this.gameActive) {
                // Opponent left, end game
                io.to(this.id).emit('opponentLeft');
                this.endGame();
            }
        }
    }
}

// Socket Connection Handler
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Store user socket
    userSockets.set(socket.id, socket);
    
    // Join Queue for matchmaking
    socket.on('joinQueue', (userData) => {
        console.log('Player joined queue:', socket.id, userData);
        
        socket.userData = userData || { username: `Player_${socket.id.substr(0, 6)}` };
        
        // Add to waiting queue
        waitingQueue.push(socket);
        
        socket.emit('queueJoined', { 
            position: waitingQueue.length,
            message: 'Looking for opponent...' 
        });
        
        // Try to match immediately
        tryMatchmaking();
    });
    
    // Handle answers
    socket.on('submitAnswer', (data) => {
        const room = findRoomByPlayer(socket);
        if(room) {
            room.handleAnswer(socket, data.answerIndex);
        }
    });
    
    // WebRTC Signaling for Voice Chat
    socket.on('offer', (data) => {
        socket.to(data.roomId).emit('offer', { 
            offer: data.offer, 
            from: socket.id 
        });
    });
    
    socket.on('answer', (data) => {
        socket.to(data.roomId).emit('answer', { 
            answer: data.answer, 
            from: socket.id 
        });
    });
    
    socket.on('ice-candidate', (data) => {
        socket.to(data.roomId).emit('ice-candidate', { 
            candidate: data.candidate, 
            from: socket.id 
        });
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove from queue
        const queueIndex = waitingQueue.findIndex(s => s.id === socket.id);
        if(queueIndex !== -1) {
            waitingQueue.splice(queueIndex, 1);
        }
        
        // Remove from active room
        const room = findRoomByPlayer(socket);
        if(room) {
            room.removePlayer(socket);
        }
        
        userSockets.delete(socket.id);
    });
});

// Matchmaking Function
function tryMatchmaking() {
    if(waitingQueue.length >= 2) {
        const player1 = waitingQueue.shift();
        const player2 = waitingQueue.shift();
        
        // Create new game room
        const room = new GameRoom(player1, player2);
        activeRooms.set(room.id, room);
        
        console.log('Match found! Room:', room.id);
        
        // Notify both players
        player1.emit('matchFound', { 
            roomId: room.id,
            opponent: player2.userData?.username || 'Anonymous',
            countdown: 5
        });
        
        player2.emit('matchFound', { 
            roomId: room.id,
            opponent: player1.userData?.username || 'Anonymous',
            countdown: 5
        });
        
        // Start game after 5 seconds
        setTimeout(() => {
            room.startGame();
        }, 5000);
    }
}

// Helper function to find room by player
function findRoomByPlayer(socket) {
    for(let room of activeRooms.values()) {
        if(room.players.some(p => p.socket.id === socket.id)) {
            return room;
        }
    }
    return null;
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server running!',
        activeRooms: activeRooms.size,
        playersInQueue: waitingQueue.length,
        totalConnections: userSockets.size
    });
});

// Get server stats
app.get('/stats', (req, res) => {
    res.json({
        activeRooms: activeRooms.size,
        playersInQueue: waitingQueue.length,
        totalConnections: userSockets.size,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 Realtime Game Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}`);
});
