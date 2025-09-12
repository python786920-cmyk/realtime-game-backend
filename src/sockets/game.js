const pool = require('../config/db');
const { generateQuestions } = require('../utils/questions');

module.exports = (io) => {
  const queues = {
    200: [],
    500: [],
    1000: [],
    2000: [],
    5000: []
  };

  const rooms = {};

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Authenticate socket
    socket.on('authenticate', (token) => {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || '7fd81c2aa5c17cb969e6e0c0bba03e35e49f84b41d4c444e';
      jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
          socket.emit('auth_error', 'Invalid token');
          socket.disconnect();
        } else {
          socket.user = user;
          socket.emit('authenticated');
        }
      });
    });

    // Join queue
    socket.on('joinQueue', async (entry_fee) => {
      if (!socket.user) return socket.emit('error', 'Not authenticated');
      if (![200, 500, 1000, 2000, 5000].includes(entry_fee)) return socket.emit('error', 'Invalid entry fee');

      const user_id = socket.user.user_id;
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [userRows] = await connection.query('SELECT coins FROM users WHERE user_id = ?', [user_id]);
        if (userRows[0].coins < entry_fee) {
          throw new Error('Insufficient coins');
        }

        await connection.query('UPDATE users SET coins = coins - ? WHERE user_id = ?', [entry_fee, user_id]);

        queues[entry_fee].push({ socket, user_id });

        if (queues[entry_fee].length >= 2) {
          const player1 = queues[entry_fee].shift();
          const player2 = queues[entry_fee].shift();

          const room_id = `room_${Date.now()}`;
          const prize_pool = entry_fee * 2;
          const questions = generateQuestions();

          const [p1Profile] = await connection.query('SELECT username, profile_logo FROM users WHERE user_id = ?', [player1.user_id]);
          const [p2Profile] = await connection.query('SELECT username, profile_logo FROM users WHERE user_id = ?', [player2.user_id]);

          rooms[room_id] = {
            players: [player1, player2],
            entry_fee,
            prize_pool,
            questions,
            scores: { [player1.user_id]: 0, [player2.user_id]: 0 },
            currentQuestion: { [player1.user_id]: 0, [player2.user_id]: 0 },
            timer: 120,
            timerInterval: null
          };

          player1.socket.join(room_id);
          player2.socket.join(room_id);

          io.to(room_id).emit('matchFound', {
            room_id,
            players: [
              { user_id: player1.user_id, username: p1Profile[0].username, profile_logo: p1Profile[0].profile_logo || 'default_avatar.png' },
              { user_id: player2.user_id, username: p2Profile[0].username, profile_logo: p2Profile[0].profile_logo || 'default_avatar.png' }
            ],
            entry_fee,
            prize_pool
          });

          setTimeout(() => {
            io.to(room_id).emit('gameStart', room_id);
            player1.socket.emit('newQuestion', questions[0]);
            player2.socket.emit('newQuestion', questions[0]);

            rooms[room_id].timerInterval = setInterval(() => {
              rooms[room_id].timer--;
              io.to(room_id).emit('timeUpdate', rooms[room_id].timer);
              if (rooms[room_id].timer <= 0) {
                clearInterval(rooms[room_id].timerInterval);
                endGame(room_id, connection);
              }
            }, 1000);
          }, 5000);

          await connection.query(
            'INSERT INTO matches (room_id, entry_fee, player1_id, player2_id, created_at) VALUES (?, ?, ?, ?, NOW())',
            [room_id, entry_fee, player1.user_id, player2.user_id]
          );
        }

        await connection.commit();
      } catch (err) {
        if (connection) await connection.rollback();
        socket.emit('error', err.message || 'Failed to join queue');
      } finally {
        if (connection) connection.release();
      }
    });

    // Submit answer
    socket.on('submitAnswer', async (data) => {
      if (!socket.user) return;
      const { room_id, question_id, answer } = data;
      const room = rooms[room_id];
      if (!room) return socket.emit('error', 'Room not found');

      const user_id = socket.user.user_id;
      if (room.currentQuestion[user_id] + 1 !== question_id) return socket.emit('error', 'Invalid question');

      const question = room.questions[question_id - 1];
      if (parseInt(answer) === question.answer) {
        room.scores[user_id]++;
        io.to(room_id).emit('updateScore', {
          scores: room.scores,
          prize_pool: room.prize_pool
        });
      }

      room.currentQuestion[user_id]++;
      if (room.currentQuestion[user_id] < room.questions.length) {
        socket.emit('newQuestion', room.questions[room.currentQuestion[user_id]]);
      }
    });

    // WebRTC signaling
    socket.on('webrtcOffer', (data) => {
      const { room_id, offer } = data;
      socket.to(room_id).emit('webrtcOffer', offer);
    });

    socket.on('webrtcAnswer', (data) => {
      const { room_id, answer } = data;
      socket.to(room_id).emit('webrtcAnswer', answer);
    });

    socket.on('webrtcICE', (data) => {
      const { room_id, candidate } = data;
      socket.to(room_id).emit('webrtcICE', candidate);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      for (const fee in queues) {
        queues[fee] = queues[fee].filter(p => p.socket.id !== socket.id);
      }
      // Handle room cleanup if needed
    });
  });

  async function endGame(room_id, connection) {
    const room = rooms[room_id];
    if (!room) return;

    const scores = room.scores;
    let winner_id = null;
    let isDraw = false;

    if (scores[room.players[0].user_id] > scores[room.players[1].user_id]) {
      winner_id = room.players[0].user_id;
    } else if (scores[room.players[1].user_id] > scores[room.players[0].user_id]) {
      winner_id = room.players[1].user_id;
    } else {
      isDraw = true;
    }

    try {
      await connection.beginTransaction();

      if (isDraw) {
        await connection.query('UPDATE users SET coins = coins + ? WHERE user_id = ?', [room.entry_fee, room.players[0].user_id]);
        await connection.query('UPDATE users SET coins = coins + ? WHERE user_id = ?', [room.entry_fee, room.players[1].user_id]);
      } else {
        await connection.query('UPDATE users SET coins = coins + ? WHERE user_id = ?', [room.prize_pool, winner_id]);
      }

      for (const player of room.players) {
        const isWin = player.user_id === winner_id;
        const isLoss = !isDraw && !isWin;
        await connection.query(
          'UPDATE users SET total_matches = total_matches + 1, wins = wins + ?, losses = losses + ? WHERE user_id = ?',
          [isWin ? 1 : 0, isLoss ? 1 : 0, player.user_id]
        );
      }

      await connection.query(
        'UPDATE matches SET winner_id = ?, score_p1 = ?, score_p2 = ? WHERE room_id = ?',
        [winner_id, scores[room.players[0].user_id], scores[room.players[1].user_id], room_id]
      );

      await connection.commit();

      io.to(room_id).emit('gameOver', {
        result: isDraw ? 'draw' : 'win',
        scores,
        winner: winner_id
      });

      delete rooms[room_id];
    } catch (err) {
      await connection.rollback();
      console.error('Error ending game:', err);
    }
  }
};
