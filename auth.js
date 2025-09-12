const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const { getUserByPhone, createUser, updateUserProfile, getUserById } = require('./db');
const logger = require('./logger');

const router = express.Router();

const registerSchema = Joi.object({
    phone: Joi.string().pattern(/^\d{10}$/).required().messages({
        'string.pattern.base': 'Phone number must be 10 digits'
    }),
    password: Joi.string().min(6).required()
});

const loginSchema = Joi.object({
    phone: Joi.string().pattern(/^\d{10}$/).required().messages({
        'string.pattern.base': 'Phone number must be 10 digits'
    }),
    password: Joi.string().min(6).required()
});

const updateProfileSchema = Joi.object({
    username: Joi.string().min(3).max(50).required()
});

router.post('/register', async (req, res) => {
    const { error } = registerSchema.validate(req.body);
    if (error) {
        logger.warn(`Registration validation error: ${error.details[0].message}`);
        return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { phone, password } = req.body;
    try {
        const existingUser = await getUserByPhone(phone);
        if (existingUser) {
            logger.warn(`Registration failed: Phone ${phone} already registered`);
            return res.status(400).json({ success: false, message: 'Phone number already registered' });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const username = `Player${Math.floor(1000 + Math.random() * 9000)}`;
        const user = await createUser(phone, password_hash, username);

        const token = jwt.sign({ user_id: user.user_id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        logger.info(`User registered: ${user.user_id}`);
        res.json({ success: true, user: { user_id: user.user_id, username, coins: user.coins, profile_logo: user.profile_logo }, token });
    } catch (error) {
        logger.error(`Registration error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/login', async (req, res) => {
    const { error } = loginSchema.validate(req.body);
    if (error) {
        logger.warn(`Login validation error: ${error.details[0].message}`);
        return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { phone, password } = req.body;
    try {
        const user = await getUserByPhone(phone);
        if (!user) {
            logger.warn(`Login failed: Invalid credentials for phone ${phone}`);
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            logger.warn(`Login failed: Incorrect password for phone ${phone}`);
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const token = jwt.sign({ user_id: user.user_id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        logger.info(`User logged in: ${user.user_id}`);
        res.json({ success: true, user: { user_id: user.user_id, username: user.username, coins: user.coins, profile_logo: user.profile_logo }, token });
    } catch (error) {
        logger.error(`Login error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/update-profile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        logger.warn('Profile update failed: No token provided');
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const { error } = updateProfileSchema.validate(req.body);
    if (error) {
        logger.warn(`Profile update validation error: ${error.details[0].message}`);
        return res.status(400).json({ success: false, message: error.details[0].message });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        await updateUserProfile(decoded.user_id, req.body.username);
        const user = await getUserById(decoded.user_id);
        logger.info(`Profile updated for user ${decoded.user_id}: ${req.body.username}`);
        res.json({ success: true, user: { user_id: user.user_id, username: user.username, coins: user.coins, profile_logo: user.profile_logo } });
    } catch (error) {
        logger.error(`Profile update error: ${error.message}`);
        res.status(401).json({ success: false, message: 'Invalid token or server error' });
    }
});

router.get('/validate', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        logger.warn('Token validation failed: No token provided');
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await getUserById(decoded.user_id);
        if (!user) {
            logger.warn(`Token validation failed: User ${decoded.user_id} not found`);
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }
        logger.info(`Token validated for user ${user.user_id}`);
        res.json({ success: true, user: { user_id: user.user_id, username: user.username, coins: user.coins, profile_logo: user.profile_logo } });
    } catch (error) {
        logger.error(`Token validation error: ${error.message}`);
        res.status(401).json({ success: false, message: 'Invalid token' });
    }
});

module.exports = router;
