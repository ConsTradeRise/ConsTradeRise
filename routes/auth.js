// ─────────────────────────────────────────────
//  ConsTradeHire — Auth Routes
//  POST /api/auth/register
//  POST /api/auth/login
//  GET  /api/auth/me
// ─────────────────────────────────────────────

'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { generateToken, requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// In-memory login failure tracker — locks account for 15 min after 10 failed attempts
const loginFailures = new Map(); // email -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginLock(email) {
  const record = loginFailures.get(email);
  if (!record) return false;
  if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginFailures.delete(email); // lock expired, reset
  }
  return false;
}

function recordLoginFailure(email) {
  const record = loginFailures.get(email) || { count: 0, lockedUntil: null };
  record.count++;
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  loginFailures.set(email, record);
}

function clearLoginFailures(email) {
  loginFailures.delete(email);
}

// ─── REGISTER ────────────────────────────────
// POST /api/auth/register
// Body: { name, email, password, role: "WORKER" | "EMPLOYER" }
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Validate name length
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Name must be under 100 characters' });
    }

    // Validate password strength (min 8 chars, must have letter + number)
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one letter and one number' });
    }

    // Validate role
    const allowedRoles = ['WORKER', 'EMPLOYER'];
    const userRole = role && allowedRoles.includes(role.toUpperCase())
      ? role.toUpperCase()
      : 'WORKER';

    // Check if email already exists
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user + profile in one transaction
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role: userRole,
        profile: {
          create: {} // empty profile — user fills it in onboarding
        }
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    const token = generateToken(user);

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user
    });

  } catch (e) {
    console.error('[auth/register]', e.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── LOGIN ────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if account is temporarily locked
    if (checkLoginLock(normalizedEmail)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        role: true,
        createdAt: true
      }
    });

    if (!user) {
      recordLoginFailure(normalizedEmail);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check ban AFTER password verify to avoid account enumeration via timing
    const isBanned = user.name.startsWith('[BANNED] ');

    // Verify password
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      recordLoginFailure(normalizedEmail);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Reject banned users AFTER password check (prevents account enumeration)
    if (isBanned) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
    }

    // Successful login — clear failure tracker
    clearLoginFailures(normalizedEmail);

    // Return token (exclude passwordHash)
    const { passwordHash, ...safeUser } = user;
    const token = generateToken(safeUser);

    res.json({
      message: 'Login successful',
      token,
      user: safeUser
    });

  } catch (e) {
    console.error('[auth/login]', e.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── ME ───────────────────────────────────────
// GET /api/auth/me
// Returns current user from JWT
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        profile: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });

  } catch (e) {
    console.error('[auth/me]', e.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ─── DELETE ACCOUNT (PIPEDA) ─────────────────
// DELETE /api/auth/account
router.delete('/account', requireAuth, async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.user.id } }); // cascades via schema
    res.json({ message: 'Account and all data deleted.' });
  } catch (e) {
    console.error('[auth/delete]', e.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
