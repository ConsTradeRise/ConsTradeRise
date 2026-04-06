// ─────────────────────────────────────────────
//  ConsTradeHire — Auth Routes
//  POST /api/auth/register
//  POST /api/auth/login
//  GET  /api/auth/me
//  GET  /api/auth/verify-email
//  POST /api/auth/resend-verification
//  POST /api/auth/forgot-password
//  POST /api/auth/reset-password
//  DELETE /api/auth/account
// ─────────────────────────────────────────────

'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { generateToken, requireAuth } = require('../middleware/auth');
const { sendEmail, baseTemplate } = require('../utils/email');

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

    // Generate email verification token
    const verifyToken  = crypto.randomBytes(32).toString('hex');
    const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user + profile in one transaction
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role: userRole,
        emailVerified: false,
        emailVerifyToken: verifyToken,
        emailVerifyExpiry: verifyExpiry,
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

    // Send verification email (non-blocking — don't fail registration if email fails)
    const baseUrl   = process.env.APP_URL || 'http://localhost:3001';
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${verifyToken}`;

    sendEmail({
      to: user.email,
      subject: 'Verify your ConsTradeHire email',
      html: baseTemplate('Verify Your Email Address', `
        <p>Hi ${user.name},</p>
        <p>Thanks for joining ConsTradeHire! Click the button below to verify your email address and activate your account.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${verifyUrl}" class="btn">Verify My Email →</a>
        </p>
        <p style="font-size:12px;color:#94a3b8;">
          This link expires in 24 hours. If you didn't create this account, you can safely ignore this email.
        </p>
        <p style="font-size:12px;color:#94a3b8;">
          If the button doesn't work, copy and paste this link into your browser:<br>
          <a href="${verifyUrl}" style="color:#f97316;word-break:break-all;">${verifyUrl}</a>
        </p>
      `)
    }).catch(() => {});

    res.status(201).json({
      message: 'Account created! Please check your email to verify your account.',
      requiresVerification: true,
      email: user.email
    });

  } catch (e) {
    console.error('[auth/register]', e.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── VERIFY EMAIL ─────────────────────────────
// GET /api/auth/verify-email?token=xxx
// Called from the link in verification email
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/login.html?verifyError=invalid');

    const user = await prisma.user.findFirst({
      where: {
        emailVerifyToken: token,
        emailVerifyExpiry: { gt: new Date() }
      }
    });

    if (!user) return res.redirect('/login.html?verifyError=expired');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyToken: null,
        emailVerifyExpiry: null
      }
    });

    res.redirect('/login.html?verified=1');
  } catch (e) {
    console.error('[auth/verify-email]', e.message);
    res.redirect('/login.html?verifyError=error');
  }
});

// ─── RESEND VERIFICATION EMAIL ────────────────
// POST /api/auth/resend-verification
// Body: { email }
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    // Always 200 — prevents email enumeration
    if (!user || user.emailVerified) {
      return res.json({ message: 'If that email exists and is unverified, a new link has been sent.' });
    }

    const verifyToken  = crypto.randomBytes(32).toString('hex');
    const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifyToken: verifyToken, emailVerifyExpiry: verifyExpiry }
    });

    const baseUrl   = process.env.APP_URL || 'http://localhost:3001';
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${verifyToken}`;

    await sendEmail({
      to: user.email,
      subject: 'Verify your ConsTradeHire email (new link)',
      html: baseTemplate('New Verification Link', `
        <p>Hi ${user.name},</p>
        <p>Here is your new email verification link. It expires in 24 hours.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${verifyUrl}" class="btn">Verify My Email →</a>
        </p>
        <p style="font-size:12px;color:#94a3b8;">
          If the button doesn't work, copy this link:<br>
          <a href="${verifyUrl}" style="color:#f97316;word-break:break-all;">${verifyUrl}</a>
        </p>
      `)
    });

    res.json({ message: 'A new verification link has been sent to your email.' });
  } catch (e) {
    console.error('[auth/resend-verification]', e.message);
    res.status(500).json({ error: 'Failed to resend verification email' });
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

    // Find user (include verification fields)
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        role: true,
        createdAt: true,
        emailVerified: true,
        emailVerifyToken: true
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

    // ── Email verification check ──────────────────
    if (!user.emailVerified) {
      // Old accounts (created before this feature) have no emailVerifyToken — auto-verify them
      if (!user.emailVerifyToken) {
        await prisma.user.update({
          where: { id: user.id },
          data: { emailVerified: true }
        });
      } else {
        // New account — must verify email first
        return res.status(403).json({
          error: 'Please verify your email before logging in. Check your inbox.',
          requiresVerification: true,
          email: user.email
        });
      }
    }

    // Successful login — clear failure tracker
    clearLoginFailures(normalizedEmail);

    // Return token (exclude passwordHash & sensitive fields)
    const { passwordHash, emailVerified, emailVerifyToken, ...safeUser } = user;
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

// ─── FORGOT PASSWORD ──────────────────────────
// POST /api/auth/forgot-password
// Body: { email }
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    // Always return 200 to prevent email enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: token, passwordResetExpiry: expiry }
    });

    const baseUrl  = process.env.APP_URL || 'http://localhost:3001';
    const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

    await sendEmail({
      to: user.email,
      subject: 'Reset your ConsTradeHire password',
      html: baseTemplate('Password Reset Request', `
        <p>Hi ${user.name},</p>
        <p>Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" class="btn">Reset Password</a>
        <p style="margin-top:20px;font-size:12px;color:#94a3b8;">
          If you didn't request this, you can safely ignore this email.
        </p>`)
    });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (e) {
    console.error('[auth/forgot-password]', e.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ─── RESET PASSWORD ───────────────────────────
// POST /api/auth/reset-password
// Body: { token, password }
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });

    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and number' });
    }

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        passwordResetExpiry: { gt: new Date() }
      }
    });

    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetToken: null, passwordResetExpiry: null }
    });

    clearLoginFailures(user.email);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (e) {
    console.error('[auth/reset-password]', e.message);
    res.status(500).json({ error: 'Failed to reset password' });
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
