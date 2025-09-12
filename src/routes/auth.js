const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || '7fd81c2aa5c17cb969e6e0c0bba03e35e49f84b41d4c444e';

// Generate username
function generateUsername(phone) {
  return `user_${phone.slice(-4)}_${Math.floor(Math.random() * 1000)}`;
}

// Register
router.post('/register', async (req, res) => {
  const { phone_number, password, confirm_password } = req.body;
  if (password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone_number]);
    if (rows.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const username = generateUsername(phone_number);
    const [result] = await pool.query(
      'INSERT INTO users (phone, password_hash, username, profile_logo, coins, total_matches, wins, losses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [phone_number, hash, username, 'default_avatar.png', 1000, 0, 0, 0]
    );
    const token = jwt.sign({ user_id: result.insertId }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { phone_number, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone_number]);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ user_id: user.user_id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT user_id, username, profile_logo, coins, total_matches, wins, losses FROM users WHERE user_id = ?',
      [req.user.user_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update Profile
router.put('/profile', authenticateToken, async (req, res) => {
  const { username, profile_logo } = req.body;
  try {
    const updates = [];
    const params = [];
    if (username) {
      updates.push('username = ?');
      params.push(username);
    }
    if (profile_logo) {
      updates.push('profile_logo = ?');
      params.push(profile_logo);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    params.push(req.user.user_id);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, params);
    res.json({ message: 'Profile updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Match History
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.*, u1.username as p1_username, u2.username as p2_username, 
       CASE WHEN winner_id = ? THEN 'win' WHEN winner_id IS NULL THEN 'draw' ELSE 'loss' END as result
       FROM matches m
       JOIN users u1 ON m.player1_id = u1.user_id
       JOIN users u2 ON m.player2_id = u2.user_id
       WHERE m.player1_id = ? OR m.player2_id = ?
       ORDER BY created_at DESC`,
      [req.user.user_id, req.user.user_id, req.user.user_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Middleware to authenticate JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

module.exports = router;
