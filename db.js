const mysql = require('mysql2/promise');
const logger = require('./logger');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function initDb() {
    const connection = await pool.getConnection();
    try {
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                user_id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(15) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                username VARCHAR(50) NOT NULL,
                profile_logo VARCHAR(255) DEFAULT NULL,
                coins INT DEFAULT 1000,
                total_matches INT DEFAULT 0,
                wins INT DEFAULT 0,
                losses INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_phone (phone)
            )
        `);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS matches (
                match_id INT AUTO_INCREMENT PRIMARY KEY,
                room_id VARCHAR(50) NOT NULL,
                entry_fee INT NOT NULL,
                player1_id INT NOT NULL,
                player2_id INT NOT NULL,
                winner_id INT DEFAULT NULL,
                score_p1 INT DEFAULT 0,
                score_p2 INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (player1_id) REFERENCES users(user_id),
                FOREIGN KEY (player2_id) REFERENCES users(user_id),
                INDEX idx_room_id (room_id)
            )
        `);
        logger.info('Database tables initialized');
    } catch (error) {
        logger.error(`Database init error: ${error.message}`);
        throw error;
    } finally {
        connection.release();
    }
}

async function getUserByPhone(phone) {
    const [rows] = await pool.execute('SELECT * FROM users WHERE phone = ?', [phone]);
    return rows[0];
}

async function getUserById(user_id) {
    const [rows] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [user_id]);
    return rows[0];
}

async function createUser(phone, password_hash, username) {
    const [result] = await pool.execute(
        'INSERT INTO users (phone, password_hash, username, coins) VALUES (?, ?, ?, ?)',
        [phone, password_hash, username, 1000]
    );
    return getUserById(result.insertId);
}

async function updateUserProfile(user_id, username) {
    await pool.execute('UPDATE users SET username = ? WHERE user_id = ?', [username, user_id]);
}

async function updateUserCoins(user_id, coins) {
    await pool.execute('UPDATE users SET coins = ? WHERE user_id = ?', [coins, user_id]);
}

async function updateUserStats(user_id, won) {
    const query = won
        ? 'UPDATE users SET total_matches = total_matches + 1, wins = wins + 1 WHERE user_id = ?'
        : 'UPDATE users SET total_matches = total_matches + 1, losses = losses + 1 WHERE user_id = ?';
    await pool.execute(query, [user_id]);
}

async function createMatch(room_id, entry_fee, player1_id, player2_id) {
    const [result] = await pool.execute(
        'INSERT INTO matches (room_id, entry_fee, player1_id, player2_id) VALUES (?, ?, ?, ?)',
        [room_id, entry_fee, player1_id, player2_id]
    );
    return result.insertId;
}

async function updateMatchResult(match_id, winner_id, score_p1, score_p2) {
    await pool.execute(
        'UPDATE matches SET winner_id = ?, score_p1 = ?, score_p2 = ? WHERE match_id = ?',
        [winner_id, score_p1, score_p2, match_id]
    );
}

async function deductEntryFee(user_id, entry_fee) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute('SELECT coins FROM users WHERE user_id = ?', [user_id]);
        const user = rows[0];
        if (user.coins < entry_fee) throw new Error('Insufficient coins');
        await connection.execute('UPDATE users SET coins = coins - ? WHERE user_id = ?', [entry_fee, user_id]);
        await connection.commit();
        logger.info(`Deducted ${entry_fee} coins from user ${user_id}`);
        return true;
    } catch (error) {
        await connection.rollback();
        logger.error(`Deduct entry fee error for user ${user_id}: ${error.message}`);
        throw error;
    } finally {
        connection.release();
    }
}

async function refundEntryFee(user_id, entry_fee) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('UPDATE users SET coins = coins + ? WHERE user_id = ?', [entry_fee, user_id]);
        await connection.commit();
        logger.info(`Refunded ${entry_fee} coins to user ${user_id}`);
    } catch (error) {
        await connection.rollback();
        logger.error(`Refund entry fee error for user ${user_id}: ${error.message}`);
        throw error;
    } finally {
        connection.release();
    }
}

async function awardPrize(user_id, prize) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('UPDATE users SET coins = coins + ? WHERE user_id = ?', [prize, user_id]);
        await connection.commit();
        logger.info(`Awarded ${prize} coins to user ${user_id}`);
    } catch (error) {
        await connection.rollback();
        logger.error(`Award prize error for user ${user_id}: ${error.message}`);
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    initDb,
    getUserByPhone,
    getUserById,
    createUser,
    updateUserProfile,
    updateUserCoins,
    updateUserStats,
    createMatch,
    updateMatchResult,
    deductEntryFee,
    refundEntryFee,
    awardPrize
};
