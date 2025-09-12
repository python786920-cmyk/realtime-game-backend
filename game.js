const { v4: uuidv4 } = require('uuid');
const { deductEntryFee, createMatch, updateMatchResult, awardPrize, refundEntryFee, updateUserStats } = require('./db');
const logger = require('./logger');

const queues = {
    200: [],
    500: [],
    1000: [],
    2000: [],
    5000: []
};

const rooms = new Map();

function generateQuestion() {
    const operations = ['+', '-', '*'];
    const operation = operations[Math.floor(Math.random() * operations.length)];
    const num1 = Math.floor(Math.random() * 50) + 1;
    const num2 = Math.floor(Math.random() * 50) + 1;
    let correctAnswer;

    switch (operation) {
        case '+': correctAnswer = num1 + num2; break;
        case '-': correctAnswer = num1 - num2; break;
        case '*': correctAnswer = num1 * num2; break;
    }

    const options = [correctAnswer];
    while (options.length < 4) {
        const offset = Math.floor(Math.random() * 10) - 5;
        const wrongAnswer = correctAnswer + offset;
        if (!options.includes(wrongAnswer) && wrongAnswer !== correctAnswer) options.push(wrongAnswer);
    }
    options.sort(() => Math.random() - 0.5);
    return {
        questionId: uuidv4(),
        text: `${num1} ${operation} ${num2} = ?`,
        options,
        correctAnswer: options.indexOf(correctAnswer)
    };
}

async function joinQueue(socket, entryFee, io) {
    if (![200, 500, 1000, 2000, 5000].includes(entryFee)) {
        throw new Error('Invalid entry fee');
    }

    await deductEntryFee(socket.user.user_id, entryFee);
    const queue = queues[entryFee];
    queue.push(socket);
    logger.info(`User ${socket.user.user_id} joined ${entryFee} coin queue`);

    if (queue.length >= 2) {
        const player1 = queue.shift();
        const player2 = queue.shift();
        const room_id = uuidv4();
        const match_id = await createMatch(room_id, entryFee, player1.user.user_id, player2.user.user_id);

        rooms.set(room_id, {
            match_id,
            entryFee,
            player1: { socket: player1, user: player1.user, score: 0 },
            player2: { socket: player2, user: player2.user, score: 0 },
            questions: Array.from({ length: 20 }, generateQuestion),
            currentQuestionIndex: 0,
            timer: 120
        });

        player1.join(room_id);
        player2.join(room_id);

        io.to(room_id).emit('matchFound', {
            room_id,
            opponent: {
                username: player1 === socket ? player2.user.username : player1.user.username,
                profile_logo: player1 === socket ? player2.user.profile_logo : player1.user.profile_logo
            },
            prizePool: entryFee * 2
        });

        logger.info(`Match created: ${room_id} with players ${player1.user.user_id} vs ${player2.user.user_id}`);
        setTimeout(() => handleGameStart(room_id, io), 2000);
    }
}

async function handleGameStart(room_id, io) {
    const room = rooms.get(room_id);
    if (!room) return;

    io.to(room_id).emit('gameStart', { room_id });
    sendQuestion(room_id, io);

    const timerInterval = setInterval(() => {
        room.timer--;
        io.to(room_id).emit('timeUpdate', { remaining: room.timer });
        if (room.timer <= 0) {
            clearInterval(timerInterval);
            endGame(room_id, io);
        }
    }, 1000);
}

function sendQuestion(room_id, io) {
    const room = rooms.get(room_id);
    if (!room || room.currentQuestionIndex >= room.questions.length) return;

    const question = room.questions[room.currentQuestionIndex];
    io.to(room_id).emit('newQuestion', question);
    logger.info(`Sent question ${room.currentQuestionIndex + 1} to room ${room_id}`);
}

async function handleAnswer(socket, { questionId, answer }, io) {
    const room_id = Array.from(socket.rooms)[1];
    const room = rooms.get(room_id);
    if (!room || room.questions[room.currentQuestionIndex].questionId !== questionId) return;

    const isPlayer1 = socket.id === room.player1.socket.id;
    const player = isPlayer1 ? room.player1 : room.player2;
    const correct = answer === room.questions[room.currentQuestionIndex].correctAnswer;

    if (correct) player.score += 1;

    io.to(room_id).emit('updateScore', {
        playerScore: isPlayer1 ? player.score : room.player2.score,
        opponentScore: isPlayer1 ? room.player2.score : player.score
    });

    room.currentQuestionIndex++;
    if (room.currentQuestionIndex < room.questions.length) {
        sendQuestion(room_id, io);
    }
    logger.info(`User ${player.user.user_id} answered question ${questionId} in room ${room_id}: ${correct ? 'Correct' : 'Incorrect'}`);
}

async function endGame(room_id, io) {
    const room = rooms.get(room_id);
    if (!room) return;

    const { player1, player2, match_id, entryFee } = room;
    let winner_id = null;
    let coinsWon = 0;

    if (player1.score > player2.score) {
        winner_id = player1.user.user_id;
        coinsWon = entryFee * 2;
        await awardPrize(winner_id, coinsWon);
        await updateUserStats(player1.user.user_id, true);
        await updateUserStats(player2.user.user_id, false);
    } else if (player2.score > player1.score) {
        winner_id = player2.user.user_id;
        coinsWon = entryFee * 2;
        await awardPrize(winner_id, coinsWon);
        await updateUserStats(player2.user.user_id, true);
        await updateUserStats(player1.user.user_id, false);
    } else {
        await refundEntryFee(player1.user.user_id, entryFee);
        await refundEntryFee(player2.user.user_id, entryFee);
        await updateUserStats(player1.user.user_id, false);
        await updateUserStats(player2.user.user_id, false);
    }

    await updateMatchResult(match_id, winner_id, player1.score, player2.score);

    io.to(room_id).emit('gameOver', {
        winner: winner_id,
        scores: { 
            player: player1.socket.id === player1.socket.id ? player1.score : player2.score, 
            opponent: player1.socket.id === player1.socket.id ? player2.score : player1.score 
        },
        coinsWon: winner_id === player1.user.user_id ? coinsWon : 0,
        updatedCoins: player1.user.coins + (winner_id === player1.user.user_id ? coinsWon : winner_id === null ? entryFee : 0)
    });

    logger.info(`Game ended in room ${room_id}: Winner ${winner_id || 'Draw'}, Scores ${player1.score}-${player2.score}`);
    rooms.delete(room_id);
}

function cleanupQueue(socket) {
    for (const entryFee in queues) {
        queues[entryFee] = queues[entryFee].filter(s => s.id !== socket.id);
    }
    logger.info(`Cleaned up queue for disconnected user ${socket.user.user_id}`);
}

module.exports = { joinQueue, handleAnswer, cleanupQueue };
