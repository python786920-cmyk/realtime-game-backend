const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mysql = require('mysql2/promise');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database connection
const dbConfig = {
  host: 'cashearnersofficial.xyz',
  user: 'cztldhwx_Auto_PostTg',
  password: 'Aptap786920',
  database: 'cztldhwx_Auto_PostTg'
};

let dbConnection;

async function initDB() {
  try {
    dbConnection = await mysql.createConnection(dbConfig);
    
    // Create tables if not exist
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        total_score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS matches (
        id VARCHAR(36) PRIMARY KEY,
        player1_id VARCHAR(36),
        player2_id VARCHAR(36),
        player1_score INT DEFAULT 0,
        player2_score INT DEFAULT 0,
        winner_id VARCHAR(36),
        duration INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player1_id) REFERENCES users(id),
        FOREIGN KEY (player2_id) REFERENCES users(id),
        FOREIGN KEY (winner_id) REFERENCES users(id)
      )
    `);
    
    console.log('✅ Database connected and tables created!');
  } catch (error) {
    console.log('⚠️ MySQL connection failed, using fallback mode');
    console.log('Error:', error.message);
  }
}

// Redis connection (fallback to in-memory if Redis not available)
let redisClient;
const gameQueue = [];
const activeGames = new Map();

async function initRedis() {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    
    redisClient.on('error', (err) => {
      console.log('Redis error:', err);
      redisClient = null;
    });
    
    await redisClient.connect();
    console.log('✅ Redis connected!');
  } catch (error) {
    console.log('⚠️ Redis connection failed, using in-memory queue');
    redisClient = null;
  }
}

// Game Engine
class MathGame {
  constructor(roomId, player1, player2) {
    this.roomId = roomId;
    this.players = {
      [player1.id]: { ...player1, score: 0, answered: false },
      [player2.id]: { ...player2, score: 0, answered: false }
    };
    this.gameState = 'waiting'; // waiting, active, finished
    this.timeLeft = 120; // 2 minutes
    this.currentQuestion = null;
    this.gameTimer = null;
    this.questionNumber = 0;
  }

  generateQuestion() {
    const num1 = Math.floor(Math.random() * 89) + 10; // 10-99
    const num2 = Math.floor(Math.random() * 89) + 10; // 10-99
    const correct = num1 + num2;
    
    // Generate 3 wrong options
    const options = [correct];
    while (options.length < 4) {
      const wrong = correct + Math.floor(Math.random() * 20) - 10;
      if (wrong > 0 && !options.includes(wrong)) {
        options.push(wrong);
      }
    }
    
    // Shuffle options
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    
    this.questionNumber++;
    this.currentQuestion = {
      id: uuidv4(),
      question: `${num1} + ${num2}`,
      options: options,
      correct: correct,
      number: this.questionNumber
    };
    
    // Reset answered status
    Object.keys(this.players).forEach(playerId => {
      this.players[playerId].answered = false;
    });
    
    return this.currentQuestion;
  }

  submitAnswer(playerId, answer, timeSpent) {
    if (this.gameState !== 'active' || this.players[playerId].answered) {
      return false;
    }
    
    this.players[playerId].answered = true;
    
    if (answer === this.currentQuestion.correct) {
      // Score calculation: base points + time bonus
      const timeBonus = Math.max(0, Math.floor((10 - timeSpent) * 2));
      const points = 10 + timeBonus;
      this.players[playerId].score += points;
    }
    
    return true;
  }

  getScoreboard() {
    return Object.values(this.players).map(p => ({
      id: p.id,
      username: p.username,
      score: p.score,
      answered: p.answered
    }));
  }

  canProceed() {
    return Object.values(this.players).every(p => p.answered) || this.timeLeft <= 0;
  }

  getWinner() {
    const scores = Object.values(this.players);
    scores.sort((a, b) => b.score - a.score);
    
    if (scores[0].score === scores[1].score) {
      return 'tie';
    }
    
    return scores[0];
  }
}

// Game Management
async function addToQueue(socket, userData) {
  const player = {
    id: socket.id,
    username: userData.username,
    socket: socket
  };

  if (redisClient) {
    await redisClient.lPush('game_queue', JSON.stringify(player));
    const queueLength = await redisClient.lLen('game_queue');
    
    if (queueLength >= 2) {
      const p1Data = await redisClient.rPop('game_queue');
      const p2Data = await redisClient.rPop('game_queue');
      
      const player1 = JSON.parse(p1Data);
      const player2 = JSON.parse(p2Data);
      
      startMatch(player1, player2);
    }
  } else {
    // Fallback to in-memory queue
    gameQueue.push(player);
    
    if (gameQueue.length >= 2) {
      const player1 = gameQueue.shift();
      const player2 = gameQueue.shift();
      startMatch(player1, player2);
    }
  }
}

function startMatch(player1, player2) {
  const roomId = uuidv4();
  const game = new MathGame(roomId, player1, player2);
  
  activeGames.set(roomId, game);
  
  // Join room
  const p1Socket = io.sockets.sockets.get(player1.id);
  const p2Socket = io.sockets.sockets.get(player2.id);
  
  if (!p1Socket || !p2Socket) {
    console.log('One or both players disconnected during matchmaking');
    return;
  }
  
  p1Socket.join(roomId);
  p2Socket.join(roomId);
  
  // Store room reference
  p1Socket.roomId = roomId;
  p2Socket.roomId = roomId;
  
  // Notify match found
  io.to(roomId).emit('matchFound', {
    roomId,
    opponent: {
      [player1.id]: { username: player2.username },
      [player2.id]: { username: player1.username }
    }
  });
  
  // Start countdown
  let countdown = 5;
  const countdownTimer = setInterval(() => {
    io.to(roomId).emit('countdown', countdown);
    countdown--;
    
    if (countdown < 0) {
      clearInterval(countdownTimer);
      startGameLoop(roomId);
    }
  }, 1000);
}

function startGameLoop(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;
  
  game.gameState = 'active';
  
  // Game timer
  game.gameTimer = setInterval(() => {
    game.timeLeft--;
    
    io.to(roomId).emit('timeUpdate', game.timeLeft);
    
    if (game.timeLeft <= 0 || game.canProceed()) {
      if (game.timeLeft > 0 && game.questionNumber < 50) {
        // Send next question
        const question = game.generateQuestion();
        io.to(roomId).emit('newQuestion', question);
        io.to(roomId).emit('scoreUpdate', game.getScoreboard());
      } else {
        // End game
        endGame(roomId);
      }
    }
  }, 1000);
  
  // Send first question
  const question = game.generateQuestion();
  io.to(roomId).emit('gameStart', {
    timeLeft: game.timeLeft,
    question: question,
    scoreboard: game.getScoreboard()
  });
}

async function endGame(roomId) {
  const game = activeGames.get(roomId);
  if (!game) return;
  
  clearInterval(game.gameTimer);
  game.gameState = 'finished';
  
  const winner = game.getWinner();
  const finalResults = {
    winner: winner,
    scoreboard: game.getScoreboard(),
    gameStats: {
      totalQuestions: game.questionNumber,
      duration: 120 - game.timeLeft
    }
  };
  
  io.to(roomId).emit('gameOver', finalResults);
  
  // Save to database
  if (dbConnection) {
    try {
      const playerIds = Object.keys(game.players);
      const scores = game.getScoreboard();
      
      await dbConnection.execute(
        `INSERT INTO matches (id, player1_id, player2_id, player1_score, player2_score, winner_id, duration) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          playerIds[0],
          playerIds[1], 
          scores[0].score,
          scores[1].score,
          winner !== 'tie' ? winner.id : null,
          120 - game.timeLeft
        ]
      );
      
      // Update player stats
      if (winner !== 'tie') {
        await dbConnection.execute(
          `UPDATE users SET wins = wins + 1, total_score = total_score + ? WHERE id = ?`,
          [winner.score, winner.id]
        );
        
        const loserId = playerIds.find(id => id !== winner.id);
        await dbConnection.execute(
          `UPDATE users SET losses = losses + 1 WHERE id = ?`,
          [loserId]
        );
      }
    } catch (error) {
      console.log('Error saving match results:', error);
    }
  }
  
  // Clean up
  setTimeout(() => {
    activeGames.delete(roomId);
  }, 30000); // Keep for 30 seconds for any final events
}

// Socket.IO Events
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  socket.on('joinQueue', async (userData) => {
    console.log(`${userData.username} joined queue`);
    
    // Create/update user in database
    if (dbConnection) {
      try {
        await dbConnection.execute(
          `INSERT INTO users (id, username) VALUES (?, ?) 
           ON DUPLICATE KEY UPDATE username = VALUES(username)`,
          [socket.id, userData.username]
        );
      } catch (error) {
        console.log('Error creating/updating user:', error);
      }
    }
    
    socket.userData = userData;
    await addToQueue(socket, userData);
    
    socket.emit('queueJoined', { message: 'Finding opponent...' });
  });
  
  socket.on('submitAnswer', (data) => {
    if (!socket.roomId) return;
    
    const game = activeGames.get(socket.roomId);
    if (!game) return;
    
    const success = game.submitAnswer(socket.id, data.answer, data.timeSpent || 0);
    
    if (success) {
      io.to(socket.roomId).emit('scoreUpdate', game.getScoreboard());
      
      // Check if both players answered or time to proceed
      if (game.canProceed() && game.timeLeft > 0 && game.questionNumber < 50) {
        setTimeout(() => {
          const question = game.generateQuestion();
          io.to(socket.roomId).emit('newQuestion', question);
        }, 1500); // 1.5 second delay before next question
      }
    }
  });
  
  // WebRTC Signaling for Voice Chat
  socket.on('offer', (data) => {
    socket.to(socket.roomId).emit('offer', data);
  });
  
  socket.on('answer', (data) => {
    socket.to(socket.roomId).emit('answer', data);
  });
  
  socket.on('ice-candidate', (data) => {
    socket.to(socket.roomId).emit('ice-candidate', data);
  });
  
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    // Remove from queue
    if (!redisClient) {
      const index = gameQueue.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        gameQueue.splice(index, 1);
      }
    }
    
    // Handle active game disconnection
    if (socket.roomId) {
      const game = activeGames.get(socket.roomId);
      if (game && game.gameState === 'active') {
        socket.to(socket.roomId).emit('opponentDisconnected');
        endGame(socket.roomId);
      }
    }
  });
});

// REST API Endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeGames: activeGames.size,
    queueSize: gameQueue.length
  });
});

app.get('/leaderboard', async (req, res) => {
  if (!dbConnection) {
    return res.json({ error: 'Database not available' });
  }
  
  try {
    const [rows] = await dbConnection.execute(
      `SELECT username, wins, losses, total_score, 
       CASE WHEN (wins + losses) = 0 THEN 0 ELSE ROUND((wins / (wins + losses)) * 100, 1) END as win_rate
       FROM users 
       WHERE (wins + losses) > 0 
       ORDER BY total_score DESC, wins DESC 
       LIMIT 20`
    );
    
    res.json({ leaderboard: rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Initialize and start server
async function startServer() {
  await initDB();
  await initRedis();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Math Battle Arena Server running on port ${PORT}`);
    console.log(`🎮 Game Queue: ${gameQueue.length} players waiting`);
    console.log(`⚡ Active Games: ${activeGames.size}`);
  });
}

startServer().catch(console.error);
