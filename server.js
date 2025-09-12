require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const authRoutes = require('./auth');
const { joinQueue, handleAnswer, cleanupQueue } = require('./game');
const { getUserById } = require('./db');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' } // Adjust for production
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit to 100 requests per window
    message: 'Too many requests, please try again later.'
}));
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    next();
});

// Routes
app.use('/api/auth', authRoutes);

// Socket.IO Authentication
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        logger.warn('Socket connection failed: No token provided');
        return next(new Error('Authentication error'));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = await getUserById(decoded.user_id);
        if (!socket.user) throw new Error('User not found');
        next();
    } catch (error) {
        logger.error(`Socket auth error: ${error.message}`);
        next(new Error('Authentication error'));
    }
});

// Socket.IO Events
io.on('connection', (socket) => {
    logger.info(`User ${socket.user.user_id} connected`);
    
    socket.on('joinQueue', async (data) => {
        try {
            await joinQueue(socket, data.entryFee, io);
        } catch (error) {
            logger.error(`Join queue error: ${error.message}`);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('submitAnswer', async (data) => {
        try {
            await handleAnswer(socket, data, io);
        } catch (error) {
            logger.error(`Submit answer error: ${error.message}`);
            socket.emit('error', { message: 'Invalid answer' });
        }
    });

    socket.on('updateProfile', async (data) => {
        try {
            const { username } = data;
            if (typeof username !== 'string' || username.length < 3) throw new Error('Invalid username');
            await updateUserProfile(socket.user.user_id, username);
            const user = await getUserById(socket.user.user_id);
            socket.user = user;
            socket.emit('profileUpdated', { user: { user_id: user.user_id, username: user.username, coins: user.coins, profile_logo: user.profile_logo } });
            logger.info(`User ${socket.user.user_id} updated profile: ${username}`);
        } catch (error) {
            logger.error(`Profile update error: ${error.message}`);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('disconnect', () => {
        logger.info(`User ${socket.user.user_id} disconnected`);
        cleanupQueue(socket);
    });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    logger.info(`Server running on port ${PORT}`);
    try {
        await require('./db').initDb();
        logger.info('Database initialized');
    } catch (error) {
        logger.error(`Database initialization failed: ${error.message}`);
    }
});
