const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

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
app.use(express.static('public'));

// In-memory storage
const users = new Map();
const queue = [];
const rooms = new Map();
const matches = new Map();

// Generate random math questions
function generateQuestion() {
  const operations = ['+', '-', '*'];
  const op = operations[Math.floor(Math.random() * operations.length)];
  let num1, num2, answer;
  
  switch(op) {
    case '+':
      num1 = Math.floor(Math.random() * 100) + 1;
      num2 = Math.floor(Math.random() * 100) + 1;
      answer = num1 + num2;
      break;
    case '-':
      num1 = Math.floor(Math.random() * 100) + 1;
      num2 = Math.floor(Math.random() * num1) + 1;
      answer = num1 - num2;
      break;
    case '*':
      num1 = Math.floor(Math.random() * 12) + 1;
      num2 = Math.floor(Math.random() * 12) + 1;
      answer = num1 * num2;
      break;
  }
  
  // Generate options
  const options = [answer];
  while (options.length < 4) {
    const randomOffset = Math.floor(Math.random() * 10) + 1;
    const wrongAnswer = answer + (Math.random() > 0.5 ? randomOffset : -randomOffset);
    if (wrongAnswer !== answer && !options.includes(wrongAnswer) && wrongAnswer > 0) {
      options.push(wrongAnswer);
    }
  }
  
  // Shuffle options
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  
  return {
    question: `${num1} ${op} ${num2}`,
    options: options,
    correctAnswer: answer
  };
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Handle user joining
  socket.on('join', (username) => {
    users.set(socket.id, {
      id: socket.id,
      username: username || `Guest_${socket.id.substr(0, 5)}`,
      score: 0,
      roomId: null,
      connected: true
    });
    
    socket.emit('joined', users.get(socket.id));
  });
  
  // Handle matchmaking request
  socket.on('findMatch', () => {
    const user = users.get(socket.id);
    if (!user) {
      socket.emit('error', 'Please join first');
      return;
    }
    
    // Add user to queue if not already there
    if (!queue.includes(socket.id)) {
      queue.push(socket.id);
      socket.emit('searching', 'Looking for opponent...');
    }
    
    // Check if we can match users
    if (queue.length >= 2) {
      const player1 = queue.shift();
      const player2 = queue.shift();
      
      // Create room
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const questionSet = [];
      
      // Generate initial questions
      for (let i = 0; i < 20; i++) {
        questionSet.push(generateQuestion());
      }
      
      rooms.set(roomId, {
        players: [player1, player2],
        scores: { [player1]: 0, [player2]: 0 },
        questions: questionSet,
        currentQuestion: 0,
        startTime: null,
        gameTimer: null,
        answeredPlayers: []
      });
      
      // Update users with room info
      users.get(player1).roomId = roomId;
      users.get(player2).roomId = roomId;
      
      // Notify players of match found
      io.to(player1).emit('matchFound', { 
        roomId, 
        opponent: users.get(player2).username,
        countdown: 5 
      });
      
      io.to(player2).emit('matchFound', { 
        roomId, 
        opponent: users.get(player1).username,
        countdown: 5 
      });
      
      // Start countdown
      let countdown = 5;
      const countdownInterval = setInterval(() => {
        io.to(roomId).emit('countdown', countdown);
        countdown--;
        
        if (countdown < 0) {
          clearInterval(countdownInterval);
          startGame(roomId);
        }
      }, 1000);
    }
  });
  
  // Handle cancel search
  socket.on('cancelSearch', () => {
    const index = queue.indexOf(socket.id);
    if (index !== -1) {
      queue.splice(index, 1);
    }
  });
  
  // Handle answer submission
  socket.on('submitAnswer', (data) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;
    
    const room = rooms.get(user.roomId);
    if (!room || room.currentQuestion >= room.questions.length) return;
    
    const currentQuestion = room.questions[room.currentQuestion];
    const isCorrect = parseInt(data.answer) === currentQuestion.correctAnswer;
    
    if (isCorrect) {
      room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;
      users.get(socket.id).score = room.scores[socket.id];
    }
    
    // Check if both players have answered
    if (!room.answeredPlayers.includes(socket.id)) {
      room.answeredPlayers.push(socket.id);
    }
    
    // Send updated scores
    io.to(user.roomId).emit('scoreUpdate', {
      player1: { id: room.players[0], score: room.scores[room.players[0]] || 0 },
      player2: { id: room.players[1], score: room.scores[room.players[1]] || 0 }
    });
    
    if (room.answeredPlayers.length === 2) {
      // Both players answered, move to next question
      room.currentQuestion++;
      room.answeredPlayers = [];
      
      if (room.currentQuestion < room.questions.length) {
        sendQuestionToRoom(user.roomId);
      } else {
        // No more questions, end game
        endGame(user.roomId);
      }
    }
  });
  
  // WebRTC signaling
  socket.on('webrtc-offer', (data) => {
    socket.to(data.target).emit('webrtc-offer', {
      offer: data.offer,
      sender: socket.id
    });
  });
  
  socket.on('webrtc-answer', (data) => {
    socket.to(data.target).emit('webrtc-answer', {
      answer: data.answer,
      sender: socket.id
    });
  });
  
  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.target).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    const user = users.get(socket.id);
    if (user && user.roomId) {
      const room = rooms.get(user.roomId);
      if (room) {
        // Notify opponent about disconnection
        const opponentId = room.players.find(id => id !== socket.id);
        if (opponentId) {
          io.to(opponentId).emit('opponentDisconnected');
        }
        
        // Clean up room
        if (room.gameTimer) clearTimeout(room.gameTimer);
        rooms.delete(user.roomId);
      }
    }
    
    // Remove from queue if present
    const queueIndex = queue.indexOf(socket.id);
    if (queueIndex !== -1) {
      queue.splice(queueIndex, 1);
    }
    
    users.delete(socket.id);
  });
});

// Start the game in a room
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.startTime = Date.now();
  sendQuestionToRoom(roomId);
  
  // Set game timer (2 minutes)
  room.gameTimer = setTimeout(() => {
    endGame(roomId);
  }, 2 * 60 * 1000);
  
  io.to(roomId).emit('gameStarted', {
    duration: 2 * 60 * 1000
  });
}

// Send question to all players in a room
function sendQuestionToRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.currentQuestion >= room.questions.length) return;
  
  const questionData = room.questions[room.currentQuestion];
  const questionToSend = {
    question: questionData.question,
    options: questionData.options,
    questionNumber: room.currentQuestion + 1,
    totalQuestions: room.questions.length
  };
  
  io.to(roomId).emit('newQuestion', questionToSend);
}

// End the game in a room
function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Clear game timer
  if (room.gameTimer) {
    clearTimeout(room.gameTimer);
    room.gameTimer = null;
  }
  
  const player1Score = room.scores[room.players[0]] || 0;
  const player2Score = room.scores[room.players[1]] || 0;
  
  let result;
  if (player1Score > player2Score) {
    result = {
      winner: room.players[0],
      loser: room.players[1],
      draw: false
    };
  } else if (player2Score > player1Score) {
    result = {
      winner: room.players[1],
      loser: room.players[0],
      draw: false
    };
  } else {
    result = {
      winner: null,
      loser: null,
      draw: true
    };
  }
  
  // Save match result
  matches.set(roomId, {
    players: room.players,
    scores: room.scores,
    result: result,
    endTime: Date.now()
  });
  
  // Send results to players
  io.to(roomId).emit('gameOver', {
    scores: room.scores,
    result: result
  });
  
  // Clean up room after a delay
  setTimeout(() => {
    // Reset user room IDs
    room.players.forEach(playerId => {
      const user = users.get(playerId);
      if (user) user.roomId = null;
    });
    
    rooms.delete(roomId);
  }, 30000); // Clean up after 30 seconds
}

// API routes
app.get('/api/stats', (req, res) => {
  res.json({
    users: users.size,
    queue: queue.length,
    rooms: rooms.size,
    matches: matches.size
  });
});

app.get('/api/user/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (user) {
    res.json(user);
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// Serve frontend if needed
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
