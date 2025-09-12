const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Replace with your frontend domain
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(cors());
app.use(express.json());

const dbConfig = {
    host: 'cashearnersofficial.xyz',
    user: 'cztldhwx_Auto_PostTg',
    password: 'Aptap786920',
    database: 'cztldhwx_Auto_PostTg'
};

const pool = mysql.createPool(dbConfig);
const JWT_SECRET = 'your_jwt_secret_key'; // Replace with secure key

let waitingQueues = { 200: [], 500: [], 1000: [], 2000: [], 5000: [] };
let activeRooms = new Map();
let playerRooms = new Map();

function generateQuestion() {
    const a = Math.floor(Math.random() * 50) + 1;
    const b = Math.floor(Math.random() * 50) + 1;
    const correctAnswer = a + b;
    const wrongAnswers = [];
    while (wrongAnswers.length < 3) {
        const wrong = correctAnswer + Math.floor(Math.random() * 20) - 10;
        if (wrong !== correctAnswer && wrong > 0 && !wrongAnswers.includes(wrong)) {
            wrongAnswers.push(wrong);
        }
    }
    const options = [correctAnswer, ...wrongAnswers].sort(() => Math.random() - 0.5);
    return {
        question_id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        question: `${a} + ${b} = ?`,
        options,
        correctAnswer,
        questionNumber: 1
    };
}

function generateQuestionSequence(count = 20) {
    const questions = [];
    for (let i = 0; i < count; i++) {
        const q = generateQuestion();
        q.questionNumber = i + 1;
        questions.push(q);
    }
    return questions;
}

async function createRoom(player1, player2, entryFee) {
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const prizePool = entryFee * 2;
    const room = {
        id: roomId,
        entryFee,
        prizePool,
        players: [
            { user_id: player1.user_id, socketId: player1.id, username: player1.username, profile_logo: player1.profile_logo, score: 0, currentQuestion: 1, isConnected: true },
            { user_id: player2.user_id, socketId: player2.id, username: player2.username, profile_logo: player2.profile_logo, score: 0, currentQuestion: 1, isConnected: true }
        ],
        questions: generateQuestionSequence(),
        gameStarted: false,
        gameEnded: false,
        timer: 120,
        timerInterval: null,
        createdAt: Date.now()
    };
    activeRooms.set(roomId, room);
    playerRooms.set(player1.id, roomId);
    playerRooms.set(player2.id, roomId);
    player1.socket.join(roomId);
    player2.socket.join(roomId);

    await pool.query(
        'INSERT INTO matches (room_id, entry_fee, player1_id, player2_id, created_at) VALUES (?, ?, ?, ?, NOW())',
        [roomId, entryFee, player1.user_id, player2.user_id]
    );

    return room;
}

function startGameTimer(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) return;
    room.timerInterval = setInterval(() => {
        room.timer--;
        io.to(roomId).emit('timeUpdate', { timeLeft: room.timer });
        if (room.timer <= 0) endGame(roomId);
    }, 1000);
}

async function endGame(roomId) {
    const room = activeRooms.get(roomId);
    if (!room || room.gameEnded) return;
    room.gameEnded = true;
    if (room.timerInterval) clearInterval(room.timerInterval);

    const [player1, player2] = room.players;
    let result;
    let winnerId = null;

    if (player1.score > player2.score) {
        result = { winner: player1.username, loser: player2.username, winnerScore: player1.score, loserScore: player2.score, isDraw: false };
        winnerId = player1.user_id;
        await updateCoinsAndStats(player1.user_id, room.prizePool, true);
        await updateCoinsAndStats(player2.user_id, 0, false);
    } else if (player2.score > player1.score) {
        result = { winner: player2.username, loser: player1.username, winnerScore: player2.score, loserScore: player1.score, isDraw: false };
        winnerId = player2.user_id;
        await updateCoinsAndStats(player2.user_id, room.prizePool, true);
        await updateCoinsAndStats(player1.user_id, 0, false);
    } else {
        result = { winner: null, loser: null, winnerScore: player1.score, loserScore: player2.score, isDraw: true };
        await refundCoins(player1.user_id, room.entryFee);
        await refundCoins(player2.user_id, room.entryFee);
    }

    await pool.query(
        'UPDATE matches SET winner_id = ?, score_p1 = ?, score_p2 = ? WHERE room_id = ?',
        [winnerId, player1.score, player2.score, roomId]
    );

    io.to(roomId).emit('gameOver', {
        result,
        finalScores: { [player1.username]: player1.score, [player2.username]: player2.score },
        prizePool: room.prizePool
    });

    setTimeout(() => cleanupRoom(roomId), 30000);
}

async function updateCoinsAndStats(user_id, coinsWon, isWin) {
    const query = isWin
        ? 'UPDATE users SET coins = coins + ?, total_matches = total_matches + 1, wins = wins + 1 WHERE user_id = ?'
        : 'UPDATE users SET total_matches = total_matches + 1, losses = losses + 1 WHERE user_id = ?';
    await pool.query(query, [coinsWon, user_id]);
}

async function refundCoins(user_id, entryFee) {
    await pool.query('UPDATE users SET coins = coins + ?, total_matches = total_matches + 1 WHERE user_id = ?', [entryFee, user_id]);
}

function cleanupRoom(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) return;
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.players.forEach(player => playerRooms.delete(player.socketId));
    activeRooms.delete(roomId);
}

app.post('/register', async (req, res) => {
    const { phone, password, confirm_password } = req.body;
    if (password !== confirm_password) return res.status(400).json({ error: 'Passwords do not match' });
    try {
        const [existing] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
        if (existing.length) return res.status(400).json({ error: 'Phone number already registered' });
        const password_hash = await bcrypt.hash(password, 10);
        const username = `Player_${Math.random().toString(36).substr(2, 6)}`;
        await pool.query(
            'INSERT INTO users (phone, password_hash, username, coins, created_at) VALUES (?, ?, ?, ?, NOW())',
            [phone, password_hash, username, 1000]
        );
        res.json({ message: 'Registration successful' });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
        if (!users.length) return res.status(400).json({ error: 'User not found' });
        const user = users[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(400).json({ error: 'Invalid password' });
        const token = jwt.sign({ user_id: user.user_id }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, user: { user_id: user.user_id, username: user.username, coins: user.coins, profile_logo: user.profile_logo } });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/profile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.query('SELECT user_id, username, profile_logo, coins, total_matches, wins, losses FROM users WHERE user_id = ?', [decoded.user_id]);
        res.json(users[0]);
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinQueue', async (data) => {
        const { entryFee, token } = data;
        if (![200, 500, 1000, 2000, 5000].includes(entryFee)) return socket.emit('error', { message: 'Invalid entry fee' });

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const [users] = await pool.query('SELECT * FROM users WHERE user_id = ?', [decoded.user_id]);
            if (!users.length) return socket.emit('error', { message: 'User not found' });
            const user = users[0];
            if (user.coins < entryFee) return socket.emit('error', { message: 'Insufficient coins' });

            await pool.query('UPDATE users SET coins = coins - ? WHERE user_id = ?', [entryFee, user.user_id]);

            const player = { id: socket.id, user_id: user.user_id, username: user.username, profile_logo: user.profile_logo, socket };
            const queue = waitingQueues[entryFee];

            if (queue.length > 0) {
                const opponent = queue.shift();
                const room = await createRoom(opponent, player, entryFee);
                io.to(room.id).emit('matchFound', {
                    roomId: room.id,
                    players: [
                        { user_id: opponent.user_id, username: opponent.username, profile_logo: opponent.profile_logo },
                        { user_id: player.user_id, username: player.username, profile_logo: player.profile_logo }
                    ],
                    entryFee,
                    prizePool: room.prizePool,
                    countdown: 5
                });

                setTimeout(() => {
                    if (activeRooms.has(room.id)) {
                        room.gameStarted = true;
                        startGameTimer(room.id);
                        io.to(room.id).emit('gameStart', { message: 'Game Started!', timer: room.timer, prizePool: room.prizePool });
                        io.to(room.id).emit('newQuestion', room.questions[0]);
                    }
                }, 5000);
            } else {
                queue.push(player);
                socket.emit('waitingForOpponent', { message: 'Looking for opponent...' });
            }
        } catch (error) {
            socket.emit('error', { message: 'Authentication failed' });
        }
    });

    socket.on('submitAnswer', async (data) => {
        const { question_id, answer } = data;
        const roomId = playerRooms.get(socket.id);
        const room = activeRooms.get(roomId);
        if (!room || room.gameEnded) return;

        const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex === -1) return;

        const player = room.players[playerIndex];
        const currentQuestionIndex = player.currentQuestion - 1;
        if (currentQuestionIndex >= room.questions.length) return;

        const question = room.questions[currentQuestionIndex];
        if (question.question_id !== question_id) return;

        const isCorrect = answer === question.correctAnswer;
        if (isCorrect) player.score++;

        socket.emit('answerResult', { correct: isCorrect, correctAnswer: question.correctAnswer, yourAnswer: answer });

        const scoreUpdate = {};
        room.players.forEach(p => scoreUpdate[p.username] = p.score);
        io.to(roomId).emit('updateScore', scoreUpdate);

        player.currentQuestion++;
        const nextQuestionIndex = player.currentQuestion - 1;
        if (nextQuestionIndex < room.questions.length) {
            socket.emit('newQuestion', room.questions[nextQuestionIndex]);
        } else {
            socket.emit('noMoreQuestions', { message: 'No more questions!' });
        }
    });

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

    socket.on('disconnect', async () => {
        console.log(`Player disconnected: ${socket.id}`);
        const queueKeys = Object.keys(waitingQueues);
        for (const key of queueKeys) {
            waitingQueues[key] = waitingQueues[key].filter(p => p.id !== socket.id);
        }

        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const room = activeRooms.get(roomId);
            if (room) {
                const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
                if (playerIndex !== -1) {
                    room.players[playerIndex].isConnected = false;
                    socket.to(roomId).emit('opponentDisconnected', { message: 'Opponent disconnected' });
                    if (room.gameStarted && !room.gameEnded) {
                        await endGame(roomId);
                    }
                }
            }
        }
    });

    socket.on('leaveGame', async () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('opponentLeft', { message: 'Opponent left the game' });
            const room = activeRooms.get(roomId);
            if (room && !room.gameEnded) {
                await endGame(roomId);
            }
        }
    });
});

app.get('/', (req, res) => {
    res.json({
        status: 'Math Quiz Game Server Running',
        timestamp: new Date().toISOString(),
        activeRooms: activeRooms.size,
        waitingPlayers: Object.values(waitingQueues).reduce((sum, q) => sum + q.length, 0)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
