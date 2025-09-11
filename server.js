const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

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

// Game state management
let waitingQueue = [];
let activeGames = new Map();
let connectedUsers = new Map();

// Question generator - Simple math questions
const generateQuestion = () => {
  const operators = ['+', '-', '*'];
  const operator = operators[Math.floor(Math.random() * operators.length)];
  
  let num1, num2, correctAnswer;
  
  switch(operator) {
    case '+':
      num1 = Math.floor(Math.random() * 50) + 1;
      num2 = Math.floor(Math.random() * 50) + 1;
      correctAnswer = num1 + num2;
      break;
    case '-':
      num1 = Math.floor(Math.random() * 50) + 25;
      num2 = Math.floor(Math.random() * 25) + 1;
      correctAnswer = num1 - num2;
      break;
    case '*':
      num1 = Math.floor(Math.random() * 12) + 1;
      num2 = Math.floor(Math.random() * 12) + 1;
      correctAnswer = num1 * num2;
      break;
  }
  
  const question = `${num1} ${operator} ${num2} = ?`;
  
  // Generate 3 wrong options
  const options = [correctAnswer];
  while(options.length < 4) {
    let wrongOption;
    if(operator === '*') {
      wrongOption = correctAnswer + Math.floor(Math.random() * 10) - 5;
    } else {
      wrongOption = correctAnswer + Math.floor(Math.random() * 20) - 10;
    }
    
    if(wrongOption !== correctAnswer && wrongOption > 0 && !options.includes(wrongOption)) {
      options.push(wrongOption);
    }
  }
  
  // Shuffle options
  for(let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  
  return {
    id: Date.now() + Math.random(),
    question,
    options,
    correctAnswer,
    timestamp: Date.now()
  };
};

// Game class
class Game {
  constructor(player1, player2) {
    this.id = Date.now() + Math.random();
    this.players = {
      [player1.id]: {
        socket: player1,
        score: 0,
        answered: false,
        username: player1.username
      },
      [player2.id]: {
        socket: player2,
        score: 0,
        answered: false,
        username: player2.username
      }
    };
    this.currentQuestion = null;
    this.gameStarted = false;
    this.gameEnded = false;
    this.startTime = null;
    this.gameDuration = 120000; // 2 minutes
    this.questionTimer = null;
    this.gameTimer = null;
  }

  start() {
    this.gameStarted = true;
    this.startTime = Date.now();
    
    // Notify both players game is starting
    Object.values(this.players).forEach(player => {
      player.socket.emit('gameStarted', {
        gameId: this.id,
        opponent: Object.values(this.players).find(p => p.socket.id !== player.socket.id).username,
        duration: this.gameDuration
      });
    });

    // Start countdown
    this.startCountdown();
  }

  startCountdown() {
    let countdown = 5;
    const countdownInterval = setInterval(() => {
      Object.values(this.players).forEach(player => {
        player.socket.emit('countdown', countdown);
      });
      
      countdown--;
      if(countdown < 0) {
        clearInterval(countdownInterval);
        this.sendNextQuestion();
        this.startGameTimer();
      }
    }, 1000);
  }

  startGameTimer() {
    this.gameTimer = setTimeout(() => {
      this.endGame();
    }, this.gameDuration);
  }

  sendNextQuestion() {
    if(this.gameEnded) return;
    
    this.currentQuestion = generateQuestion();
    
    // Reset answered status
    Object.values(this.players).forEach(player => {
      player.answered = false;
    });

    // Send question to both players
    Object.values(this.players).forEach(player => {
      player.socket.emit('newQuestion', {
        id: this.currentQuestion.id,
        question: this.currentQuestion.question,
        options: this.currentQuestion.options,
        timeRemaining: this.getRemainingTime()
      });
    });
  }

  handleAnswer(playerId, answer) {
    if(this.gameEnded || !this.currentQuestion) return;
    
    const player = this.players[playerId];
    if(!player || player.answered) return;

    player.answered = true;
    
    // Check if answer is correct
    const isCorrect = answer === this.currentQuestion.correctAnswer;
    if(isCorrect) {
      player.score += 1;
    }

    // Send result to the player who answered
    player.socket.emit('answerResult', {
      correct: isCorrect,
      correctAnswer: this.currentQuestion.correctAnswer,
      yourScore: player.score,
      opponentScore: Object.values(this.players).find(p => p.socket.id !== player.socket.id).score
    });

    // Update scores for both players
    this.broadcastScores();

    // Check if both players have answered
    const bothAnswered = Object.values(this.players).every(p => p.answered);
    
    if(bothAnswered) {
      // Wait a moment then send next question
      setTimeout(() => {
        this.sendNextQuestion();
      }, 1500);
    } else {
      // Wait for other player or timeout after 10 seconds
      setTimeout(() => {
        if(!Object.values(this.players).every(p => p.answered)) {
          this.sendNextQuestion();
        }
      }, 10000);
    }
  }

  broadcastScores() {
    const scores = {};
    Object.entries(this.players).forEach(([id, player]) => {
      scores[player.username] = player.score;
    });

    Object.values(this.players).forEach(player => {
      const opponent = Object.values(this.players).find(p => p.socket.id !== player.socket.id);
      player.socket.emit('scoreUpdate', {
        yourScore: player.score,
        opponentScore: opponent.score,
        yourName: player.username,
        opponentName: opponent.username
      });
    });
  }

  getRemainingTime() {
    if(!this.startTime) return this.gameDuration;
    return Math.max(0, this.gameDuration - (Date.now() - this.startTime));
  }

  endGame() {
    if(this.gameEnded) return;
    
    this.gameEnded = true;
    
    if(this.gameTimer) clearTimeout(this.gameTimer);
    if(this.questionTimer) clearTimeout(this.questionTimer);

    // Determine winner
    const playerArray = Object.values(this.players);
    const player1 = playerArray[0];
    const player2 = playerArray[1];
    
    let result;
    if(player1.score > player2.score) {
      result = {
        winner: player1.username,
        loser: player2.username,
        winnerScore: player1.score,
        loserScore: player2.score
      };
    } else if(player2.score > player1.score) {
      result = {
        winner: player2.username,
        loser: player1.username,
        winnerScore: player2.score,
        loserScore: player1.score
      };
    } else {
      result = {
        winner: null,
        tie: true,
        player1: player1.username,
        player2: player2.username,
        score: player1.score
      };
    }

    // Send results to both players
    Object.values(this.players).forEach(player => {
      const isWinner = result.winner === player.username;
      const opponent = Object.values(this.players).find(p => p.socket.id !== player.socket.id);
      
      player.socket.emit('gameEnded', {
        result: result.tie ? 'tie' : (isWinner ? 'win' : 'lose'),
        yourScore: player.score,
        opponentScore: opponent.score,
        winner: result.winner,
        tie: result.tie
      });
    });

    // Clean up
    activeGames.delete(this.id);
  }

  handlePlayerDisconnect(playerId) {
    const disconnectedPlayer = this.players[playerId];
    if(!disconnectedPlayer) return;

    const remainingPlayer = Object.values(this.players).find(p => p.socket.id !== playerId);
    
    if(remainingPlayer) {
      remainingPlayer.socket.emit('opponentDisconnected');
    }

    this.endGame();
  }
}

// Socket connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle user joining
  socket.on('joinGame', (data) => {
    const username = data.username || `Player${Math.floor(Math.random() * 1000)}`;
    
    connectedUsers.set(socket.id, {
      id: socket.id,
      username,
      socket
    });

    socket.emit('joinedSuccessfully', { username });
  });

  // Handle matchmaking
  socket.on('findMatch', () => {
    const user = connectedUsers.get(socket.id);
    if(!user) return;

    // Add to waiting queue
    waitingQueue.push(user);
    socket.emit('searchingMatch');

    // Try to match with someone
    if(waitingQueue.length >= 2) {
      const player1 = waitingQueue.shift();
      const player2 = waitingQueue.shift();

      // Create new game
      const game = new Game(player1, player2);
      activeGames.set(game.id, game);

      // Notify players match found
      player1.socket.emit('matchFound', { opponent: player2.username });
      player2.socket.emit('matchFound', { opponent: player1.username });

      // Start game after 2 seconds
      setTimeout(() => {
        game.start();
      }, 2000);
    }
  });

  // Handle answer submission
  socket.on('submitAnswer', (data) => {
    // Find which game this player is in
    const game = Array.from(activeGames.values()).find(g => 
      g.players[socket.id]
    );
    
    if(game) {
      game.handleAnswer(socket.id, data.answer);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove from waiting queue
    waitingQueue = waitingQueue.filter(user => user.id !== socket.id);
    
    // Handle game disconnection
    const game = Array.from(activeGames.values()).find(g => 
      g.players[socket.id]
    );
    
    if(game) {
      game.handlePlayerDisconnect(socket.id);
    }

    // Remove from connected users
    connectedUsers.delete(socket.id);
  });

  // Handle cancel search
  socket.on('cancelSearch', () => {
    waitingQueue = waitingQueue.filter(user => user.id !== socket.id);
    socket.emit('searchCancelled');
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Quiz Battle Server Running',
    connectedUsers: connectedUsers.size,
    activeGames: activeGames.size,
    waitingQueue: waitingQueue.length
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quiz Battle Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

module.exports = app;
