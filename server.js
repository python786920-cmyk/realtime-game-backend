const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
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

let db;

async function initDatabase() {
  try {
    db = mysql.createPool(dbConfig);
    
    // Create tables if they don't exist
    await db.execute(`
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
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS matches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        player1_id INT,
        player2_id INT,
        player1_score INT DEFAULT 0,
        player2_score INT DEFAULT 0,
        winner_id INT,
        duration INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player1_id) REFERENCES users(id),
        FOREIGN KEY (player2_id) REFERENCES users(id),
        FOREIGN KEY (winner_id) REFERENCES users(id)
      )
    `);
    
    console.log('✅ Database connected and tables ready');
  } catch (error) {
    console.error('❌ Database error:', error);
  }
}

// Game state management
const waitingQueue = [];
const activeGames = new Map();
const playerSockets = new Map();

// Generate math question
function generateQuestion() {
  const a = Math.floor(Math.random() * 90) + 10; // 10-99
  const b = Math.floor(Math.random() * 90) + 10; // 10-99
  const correct = a + b;
  
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
  
  return {
    question: `${a} + ${b} = ?`,
    options: options,
    correct: correct,
    correctIndex: options.indexOf(correct)
  };
}

// API Routes
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/api/register', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    
    const [result] = await db.execute(
      'INSERT IGNORE INTO users (username) VALUES (?)',
      [username]
    );
    
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    
    const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    res.json({ user: rows[0] });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT username, total_games, wins, losses, total_score,
             ROUND((wins / GREATEST(total_games, 1)) * 100, 1) as win_rate
      FROM users 
      WHERE total_games > 0
      ORDER BY total_score DESC, win_rate DESC 
      LIMIT 10
    `);
    res.json(rows);
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);
  
  socket.on('setUsername', async (username) => {
    try {
      const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
      if (rows.length > 0) {
        socket.username = username;
        socket.userId = rows[0].id;
        playerSockets.set(socket.id, socket);
        socket.emit('usernameSet', { user: rows[0] });
      } else {
        socket.emit('error', { message: 'User not found' });
      }
    } catch (error) {
      socket.emit('error', { message: 'Database error' });
    }
  });
  
  socket.on('joinQueue', () => {
    if (!socket.username) {
      socket.emit('error', { message: 'Please set username first' });
      return;
    }
    
    // Check if already in queue or game
    if (waitingQueue.some(p => p.id === socket.id) || 
        Array.from(activeGames.values()).some(game => 
          game.player1.id === socket.id || game.player2.id === socket.id)) {
      return;
    }
    
    waitingQueue.push({
      id: socket.id,
      username: socket.username,
      userId: socket.userId,
      socket: socket
    });
    
    socket.emit('queueJoined', { position: waitingQueue.length });
    
    // Try to match players
    if (waitingQueue.length >= 2) {
      const player1 = waitingQueue.shift();
      const player2 = waitingQueue.shift();
      
      const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const gameState = {
        id: gameId,
        player1: player1,
        player2: player2,
        scores: { [player1.id]: 0, [player2.id]: 0 },
        questions: { [player1.id]: null, [player2.id]: null },
        gameStarted: false,
        gameEnded: false,
        startTime: null,
        duration: 120 // 2 minutes
      };
      
      activeGames.set(gameId, gameState);
      
      // Join both players to the game room
      player1.socket.join(gameId);
      player2.socket.join(gameId);
      
      // Notify both players
      io.to(gameId).emit('matchFound', {
        opponent: {
          player1: { username: player1.username },
          player2: { username: player2.username }
        }
      });
      
      // Start countdown
      let countdown = 5;
      const countdownTimer = setInterval(() => {
        io.to(gameId).emit('countdown', countdown);
        countdown--;
        
        if (countdown < 0) {
          clearInterval(countdownTimer);
          startGame(gameId);
        }
      }, 1000);
    }
  });
  
  socket.on('submitAnswer', (data) => {
    const game = findGameByPlayerId(socket.id);
    if (!game || !game.gameStarted || game.gameEnded) return;
    
    const playerQuestion = game.questions[socket.id];
    if (!playerQuestion) return;
    
    const isCorrect = data.answer === playerQuestion.correctIndex;
    if (isCorrect) {
      game.scores[socket.id]++;
    }
    
    // Send new question to this player
    const newQuestion = generateQuestion();
    game.questions[socket.id] = newQuestion;
    
    socket.emit('newQuestion', {
      question: newQuestion.question,
      options: newQuestion.options,
      isCorrect: isCorrect,
      score: game.scores[socket.id]
    });
    
    // Broadcast scores to both players
    io.to(game.id).emit('scoreUpdate', {
      player1: {
        username: game.player1.username,
        score: game.scores[game.player1.id]
      },
      player2: {
        username: game.player2.username,
        score: game.scores[game.player2.id]
      }
    });
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.id}`);
    
    // Remove from queue
    const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1);
    }
    
    // Handle game disconnection
    const game = findGameByPlayerId(socket.id);
    if (game && !game.gameEnded) {
      game.gameEnded = true;
      const opponentId = game.player1.id === socket.id ? game.player2.id : game.player1.id;
      const opponentSocket = playerSockets.get(opponentId);
      
      if (opponentSocket) {
        opponentSocket.emit('opponentDisconnected');
      }
      
      activeGames.delete(game.id);
    }
    
    playerSockets.delete(socket.id);
  });
});

function findGameByPlayerId(playerId) {
  for (const game of activeGames.values()) {
    if (game.player1.id === playerId || game.player2.id === playerId) {
      return game;
    }
  }
  return null;
}

async function startGame(gameId) {
  const game = activeGames.get(gameId);
  if (!game) return;
  
  game.gameStarted = true;
  game.startTime = Date.now();
  
  // Generate initial questions for both players
  game.questions[game.player1.id] = generateQuestion();
  game.questions[game.player2.id] = generateQuestion();
  
  // Send game start event
  game.player1.socket.emit('gameStart', {
    question: game.questions[game.player1.id].question,
    options: game.questions[game.player1.id].options,
    duration: game.duration
  });
  
  game.player2.socket.emit('gameStart', {
    question: game.questions[game.player2.id].question,
    options: game.questions[game.player2.id].options,
    duration: game.duration
  });
  
  // Set game timer
  setTimeout(() => endGame(gameId), game.duration * 1000);
}

async function endGame(gameId) {
  const game = activeGames.get(gameId);
  if (!game || game.gameEnded) return;
  
  game.gameEnded = true;
  
  const player1Score = game.scores[game.player1.id];
  const player2Score = game.scores[game.player2.id];
  
  let winnerId = null;
  if (player1Score > player2Score) winnerId = game.player1.userId;
  else if (player2Score > player1Score) winnerId = game.player2.userId;
  
  try {
    // Save match to database
    await db.execute(`
      INSERT INTO matches (player1_id, player2_id, player1_score, player2_score, winner_id, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [game.player1.userId, game.player2.userId, player1Score, player2Score, winnerId, game.duration]);
    
    // Update user stats
    await db.execute(`
      UPDATE users SET 
        total_games = total_games + 1,
        wins = wins + ?,
        losses = losses + ?,
        total_score = total_score + ?
      WHERE id = ?
    `, [winnerId === game.player1.userId ? 1 : 0, 
        winnerId === game.player1.userId ? 0 : (winnerId ? 1 : 0), 
        player1Score, game.player1.userId]);
    
    await db.execute(`
      UPDATE users SET 
        total_games = total_games + 1,
        wins = wins + ?,
        losses = losses + ?,
        total_score = total_score + ?
      WHERE id = ?
    `, [winnerId === game.player2.userId ? 1 : 0, 
        winnerId === game.player2.userId ? 0 : (winnerId ? 1 : 0), 
        player2Score, game.player2.userId]);
        
  } catch (error) {
    console.error('Error saving game results:', error);
  }
  
  // Send results to both players
  const results = {
    gameEnded: true,
    finalScores: {
      player1: { username: game.player1.username, score: player1Score },
      player2: { username: game.player2.username, score: player2Score }
    },
    winner: winnerId ? (winnerId === game.player1.userId ? game.player1.username : game.player2.username) : 'Draw'
  };
  
  io.to(gameId).emit('gameEnd', results);
  
  // Clean up
  activeGames.delete(gameId);
}

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🎮 Math Battle Game Server Ready!`);
  });
}

startServer();
