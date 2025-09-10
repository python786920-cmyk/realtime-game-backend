const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = new Map();
        this.gameState = 'waiting';
        this.currentQuestion = null;
        this.gameStartTime = null;
        this.gameEndTime = null;
        this.gameDuration = 120000;
        this.questionIndex = 0;
        this.playerAnswers = new Map();
    }

    addPlayer(socketId, username) {
        if (this.players.size >= 2) return false;
        this.players.set(socketId, {
            id: socketId,
            username,
            score: 0,
            answered: false
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
        this.sendNextQuestion();
    }

    generateQuestion() {
        const operations = ['+', '-', '*'];
        const operation = operations[Math.floor(Math.random() * operations.length)];
        let num1, num2, correctAnswer;

        switch (operation) {
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

        const options = [correctAnswer];
        while (options.length < 4) {
            const wrong = correctAnswer + Math.floor(Math.random() * 20) - 10;
            if (!options.includes(wrong) && wrong !== correctAnswer && wrong > 0) {
                options.push(wrong);
            }
        }
        options.sort(() => Math.random() - 0.5);
        this.questionIndex++;
        return { id: this.questionIndex, question: `${num1} ${operation} ${num2} = ?`, options, correctAnswer };
    }

    sendNextQuestion() {
        const question = this.generateQuestion();
        this.currentQuestion = question;
        this.players.forEach(player => player.answered = false);
        this.playerAnswers.clear();
        io.to(this.id).emit('nextQuestion', { question });
        return question;
    }

    submitAnswer(socketId, answer) {
        const player = this.getPlayer(socketId);
        if (!player || player.answered) return false;
        const isCorrect = answer === this.currentQuestion.correctAnswer;
        if (isCorrect) player.score++;
        player.answered = true;
        this.playerAnswers.set(socketId, { answer, isCorrect });
        return { isCorrect, correctAnswer: this.currentQuestion.correctAnswer };
    }

    checkIfAllAnswered() {
        return Array.from(this.players.values()).every(p => p.answered);
    }

    isGameTimeUp() {
        return this.gameEndTime && Date.now() >= this.gameEndTime;
    }

    getGameResult() {
        const players = this.getAllPlayers().sort((a, b) => b.score - a.score);
        return {
            winner: players[0].score > players[1].score ? players[0].username : null,
            players
        };
    }

    getRemainingTime() {
        return Math.max(0, this.gameEndTime - Date.now());
    }
}

const gameRooms = new Map();
const waitingQueue = [];
const playerSocketMap = new Map();

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

function cleanupRoom(roomId) {
    const room = gameRooms.get(roomId);
    if (room && room.isEmpty()) {
        gameRooms.delete(roomId);
    }
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('joinQueue', ({ username }) => {
        waitingQueue.push({ socketId: socket.id, username });
        socket.emit('queueJoined', { queuePosition: waitingQueue.length });

        if (waitingQueue.length >= 2) {
            const [player1, player2] = waitingQueue.splice(0, 2);
            const roomId = generateRoomId();
            const room = new GameRoom(roomId);
            room.addPlayer(player1.socketId, player1.username);
            room.addPlayer(player2.socketId, player2.username);
            gameRooms.set(roomId, room);
            playerSocketMap.set(player1.socketId, roomId);
            playerSocketMap.set(player2.socketId, roomId);
            io.to(player1.socketId).join(roomId);
            io.to(player2.socketId).join(roomId);
            io.to(roomId).emit('matchFound', { roomId, players: room.getAllPlayers() });

            setTimeout(() => {
                room.startGame();
                io.to(roomId).emit('gameStart', { question: room.currentQuestion });
                const timer = setInterval(() => {
                    if (room.isGameTimeUp()) {
                        clearInterval(timer);
                        endGame(roomId);
                    } else {
                        io.to(roomId).emit('timeUpdate', { remainingTime: room.getRemainingTime() });
                    }
                }, 1000);
            }, 5000);
        }
    });

    socket.on('submitAnswer', ({ answer }) => {
        const roomId = playerSocketMap.get(socket.id);
        const room = gameRooms.get(roomId);
        if (!room || room.gameState !== 'playing') return;

        const result = room.submitAnswer(socket.id, answer);
        if (result) {
            socket.emit('answerResult', { isCorrect: result.isCorrect, correctAnswer: result.correctAnswer, yourAnswer: answer });
            io.to(roomId).emit('scoreUpdate', { players: room.getAllPlayers() });
            if (room.checkIfAllAnswered() && !room.isGameTimeUp()) {
                setTimeout(() => {
                    room.sendNextQuestion();
                }, 1500);
            }
        }
    });

    socket.on('voiceOffer', async ({ offer }) => {
        const roomId = playerSocketMap.get(socket.id);
        socket.to(roomId).emit('voiceOffer', { offer, from: socket.id });
    });

    socket.on('voiceAnswer', ({ answer, from }) => {
        socket.to(from).emit('voiceAnswer', { answer });
    });

    socket.on('iceCandidate', ({ candidate }) => {
        const roomId = playerSocketMap.get(socket.id);
        socket.to(roomId).emit('iceCandidate', { candidate });
    });

    socket.on('stopVoiceChat', () => {
        const roomId = playerSocketMap.get(socket.id);
        socket.to(roomId).emit('stopVoiceChat');
    });

    socket.on('disconnect', () => {
        const roomId = playerSocketMap.get(socket.id);
        if (roomId) {
            const room = gameRooms.get(roomId);
            if (room) {
                room.removePlayer(socket.id);
                socket.to(roomId).emit('opponentDisconnected');
                cleanupRoom(roomId);
            }
            playerSocketMap.delete(socket.id);
        }
        waitingQueue.splice(waitingQueue.findIndex(p => p.socketId === socket.id), 1);
    });
});

function endGame(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;
    room.gameState = 'finished';
    const result = room.getGameResult();
    io.to(roomId).emit('gameEnd', { result, finalScores: result.players });
    setTimeout(() => {
        room.players.forEach((_, socketId) => playerSocketMap.delete(socketId));
        cleanupRoom(roomId);
    }, 30000);
}

app.get('/', (req, res) => res.json({ status: 'Server Running', activeRooms: gameRooms.size }));
server.listen(process.env.PORT || 3000, () => console.log('Server running'));
