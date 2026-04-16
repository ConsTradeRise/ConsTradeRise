// ─────────────────────────────────────────────
//  ConsTradeHire — Auth Routes (OTP-based)
//  POST /api/auth/register
//  POST /api/auth/verify-email-otp
//  POST /api/auth/login
//  POST /api/auth/verify-login-otp
//  POST /api/auth/resend-otp
//  GET  /api/auth/me
//  POST /api/auth/forgot-password
//  POST /api/auth/reset-password
//  DELETE /api/auth/account
// ─────────────────────────────────────────────

'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { randomInt } = require('crypto');
const prisma   = require('../utils/prisma');
const { generateToken, requireAuth } = require('../middleware/auth');
const { sendEmail, baseTemplate }    = require('../utils/email');

const router = express.Router();

// ── Helpers ───────────────────────────────────
function generateOtp() {
  return String(randomInt(100000, 1000000));
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function otpEmailHtml(name, otp, purposeLabel, expiryMins = 10) {
  return baseTemplate(`Your ${purposeLabel} Code`, `
    <p>Hi ${name},</p>
    <p>Use the 6-digit code below to complete your ${purposeLabel.toLowerCase()}. It expires in ${expiryMins} minutes.</p>
    <div style="text-align:center;margin:32px 0;">
      <div style="display:inline-block;background:#f97316;color:#fff;font-size:36px;font-weight:900;
                  letter-spacing:10px;padding:18px 32px;border-radius:12px;font-family:monospace;">
        ${otp}
      </div>
    </div>
    <p style="font-size:13px;color:#64748b;text-align:center;">
      Do not share this code with anyone.<br>
      If you didn't request this, you can safely ignore this email.
    </p>
  `);
}

// Login failure tracker (in-memory)
const loginFailures = new Map();
const MAX_LOGIN_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkLoginLock(email) {
  const r = loginFailures.get(email);
  if (!r) return false;
  if (r.lockedUntil && Date.now() < r.lockedUntil) return true;
  if (r.lockedUntil && Date.now() >= r.lockedUntil) loginFailures.delete(email);
  return false;
}
function recordLoginFailure(email) {
  const r = loginFailures.get(email) || { count: 0, lockedUntil: null };
  r.count++;
  if (r.count >= MAX_LOGIN_ATTEMPTS) r.lockedUntil = Date.now() + LOCKOUT_MS;
  loginFailures.set(email, r);
}
function clearLoginFailures(email) { loginFailures.delete(email); }

// OTP resend rate-limit: 60s between sends
const OTP_EXPIRY_MS   = 10 * 60 * 1000;  // 10 minutes
const OTP_RESEND_COOL = 60 * 1000;        // 1 minute cooldown

// ─── REGISTER ────────────────────────────────
// POST /api/auth/register
// Body: { name, email, password, role }
// Returns: { requiresOtp: true, email, masked }
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password are required' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email address' });

    if (name.trim().length > 100)
      return res.status(400).json({ error: 'Name must be under 100 characters' });

    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password must contain at least one letter and one number' });

    const userRole = ['WORKER','EMPLOYER'].includes((role||'').toUpperCase())
      ? role.toUpperCase() : 'WORKER';

    const normalizedEmail = email.toLowerCase().trim();

    // Check duplicate
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      // If unverified, allow re-sending OTP instead of hard error
      if (!existing.emailVerified) {
        return res.status(409).json({
          error: 'An account with this email is pending verification.',
          requiresOtp: true,
          email: normalizedEmail,
          masked: maskEmail(normalizedEmail),
          resend: true
        });
      }
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const otp          = generateOtp();
    const otpExpiry    = new Date(Date.now() + OTP_EXPIRY_MS);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: userRole,
        emailVerified: false,
        otpCode:    otp,
        otpExpiry,
        otpPurpose: 'VERIFY_EMAIL',
        otpResendAt: new Date(),
        profile: { create: {} }
      },
      select: { id: true, name: true, email: true }
    });

    // Send OTP (fire-and-forget)
    sendEmail({
      to: user.email,
      subject: 'Your ConsTradeHire verification code',
      html: otpEmailHtml(user.name, otp, 'Email Verification')
    }).catch(() => {});

    res.status(201).json({
      requiresOtp: true,
      email: user.email,
      masked: maskEmail(user.email)
    });

  } catch (e) {
    console.error('[auth/register]', e.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── VERIFY EMAIL OTP ─────────────────────────
// POST /api/auth/verify-email-otp
// Body: { email, otp }
// Returns: { token, user }
router.post('/verify-email-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ error: 'Email and code are required' });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!user)
      return res.status(400).json({ error: 'Invalid code or email' });

    if (user.emailVerified)
      return res.status(400).json({ error: 'Email already verified. You can log in.' });

    if (
      user.otpPurpose !== 'VERIFY_EMAIL' ||
      user.otpCode   !== otp.trim() ||
      !user.otpExpiry || user.otpExpiry < new Date()
    ) {
      return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    }

    // Mark verified, clear OTP
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        otpCode: null, otpExpiry: null, otpPurpose: null, otpResendAt: null
      }
    });

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
    const token    = generateToken(safeUser);

    res.json({ message: 'Email verified! Welcome to ConsTradeHire.', token, user: safeUser });

  } catch (e) {
    console.error('[auth/verify-email-otp]', e.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ─── LOGIN ────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// Returns: { requiresOtp: true, email, masked }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const normalizedEmail = email.toLowerCase().trim();

    if (checkLoginLock(normalizedEmail))
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true, name: true, email: true, passwordHash: true,
        role: true, createdAt: true, emailVerified: true,
        emailVerifyToken: true, otpCode: true, otpExpiry: true,
        otpPurpose: true, otpResendAt: true
      }
    });

    if (!user) {
      recordLoginFailure(normalizedEmail);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isBanned = user.name.startsWith('[BANNED] ');
    const validPwd = await bcrypt.compare(password, user.passwordHash);
    if (!validPwd) {
      recordLoginFailure(normalizedEmail);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (isBanned)
      return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });

    // If unverified, redirect to email verification OTP
    if (!user.emailVerified) {
      // Re-send verification OTP if not rate-limited
      const canResend = !user.otpResendAt || (Date.now() - user.otpResendAt.getTime()) > OTP_RESEND_COOL;
      if (canResend) {
        const otp = generateOtp();
        await prisma.user.update({
          where: { id: user.id },
          data: { otpCode: otp, otpExpiry: new Date(Date.now() + OTP_EXPIRY_MS), otpPurpose: 'VERIFY_EMAIL', otpResendAt: new Date() }
        });
        sendEmail({
          to: user.email,
          subject: 'Your ConsTradeHire verification code',
          html: otpEmailHtml(user.name, otp, 'Email Verification')
        }).catch(() => {});
      }
      return res.status(403).json({
        error: 'Please verify your email first. A new code has been sent.',
        requiresVerification: true,
        requiresOtp: true,
        email: user.email,
        masked: maskEmail(user.email)
      });
    }

    // Generate login OTP
    const otp = generateOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: otp,
        otpExpiry: new Date(Date.now() + OTP_EXPIRY_MS),
        otpPurpose: 'LOGIN',
        otpResendAt: new Date()
      }
    });

    sendEmail({
      to: user.email,
      subject: 'Your ConsTradeHire login code',
      html: otpEmailHtml(user.name, otp, 'Login')
    }).catch(() => {});

    clearLoginFailures(normalizedEmail);

    res.json({
      requiresOtp: true,
      email: user.email,
      masked: maskEmail(user.email)
    });

  } catch (e) {
    console.error('[auth/login]', e.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── VERIFY LOGIN OTP ─────────────────────────
// POST /api/auth/verify-login-otp
// Body: { email, otp }
// Returns: { token, user }
router.post('/verify-login-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ error: 'Email and code are required' });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!user)
      return res.status(400).json({ error: 'Invalid code' });

    if (
      user.otpPurpose !== 'LOGIN' ||
      user.otpCode   !== otp.trim() ||
      !user.otpExpiry || user.otpExpiry < new Date()
    ) {
      return res.status(400).json({ error: 'Invalid or expired code. Try logging in again.' });
    }

    // Clear OTP
    await prisma.user.update({
      where: { id: user.id },
      data: { otpCode: null, otpExpiry: null, otpPurpose: null, otpResendAt: null }
    });

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
    const token    = generateToken(safeUser);

    res.json({ message: 'Login successful', token, user: safeUser });

  } catch (e) {
    console.error('[auth/verify-login-otp]', e.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ─── RESEND OTP ───────────────────────────────
// POST /api/auth/resend-otp
// Body: { email, purpose }  purpose: VERIFY_EMAIL | LOGIN | RESET_PASSWORD
router.post('/resend-otp', async (req, res) => {
  try {
    const { email, purpose } = req.body;
    if (!email || !purpose)
      return res.status(400).json({ error: 'Email and purpose are required' });

    const allowed = ['VERIFY_EMAIL', 'LOGIN', 'RESET_PASSWORD'];
    if (!allowed.includes(purpose))
      return res.status(400).json({ error: 'Invalid purpose' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    // Always 200 — prevents enumeration
    if (!user) return res.json({ message: 'If that email exists, a new code has been sent.' });

    // Rate limit: 60s between resends
    if (user.otpResendAt && (Date.now() - user.otpResendAt.getTime()) < OTP_RESEND_COOL) {
      const waitSecs = Math.ceil((OTP_RESEND_COOL - (Date.now() - user.otpResendAt.getTime())) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSecs} seconds before requesting a new code.` });
    }

    const otp = generateOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: { otpCode: otp, otpExpiry: new Date(Date.now() + OTP_EXPIRY_MS), otpPurpose: purpose, otpResendAt: new Date() }
    });

    const labels = { VERIFY_EMAIL: 'Email Verification', LOGIN: 'Login', RESET_PASSWORD: 'Password Reset' };
    const subjects = {
      VERIFY_EMAIL:    'Your ConsTradeHire verification code',
      LOGIN:           'Your ConsTradeHire login code',
      RESET_PASSWORD:  'Your ConsTradeHire password reset code'
    };

    sendEmail({
      to: user.email,
      subject: subjects[purpose],
      html: otpEmailHtml(user.name, otp, labels[purpose])
    }).catch(() => {});

    res.json({ message: 'A new code has been sent to your email.' });

  } catch (e) {
    console.error('[auth/resend-otp]', e.message);
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

// ─── ME ───────────────────────────────────────
// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, role: true, createdAt: true, profile: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    console.error('[auth/me]', e.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ─── FORGOT PASSWORD ──────────────────────────
// POST /api/auth/forgot-password
// Body: { email }
// Returns: { requiresOtp: true, email, masked }
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    // Always 200 (prevents enumeration), but still signal OTP step
    if (!user)
      return res.json({ requiresOtp: true, masked: maskEmail(email.toLowerCase().trim()) });

    // Rate limit
    if (user.otpResendAt && (Date.now() - user.otpResendAt.getTime()) < OTP_RESEND_COOL) {
      const waitSecs = Math.ceil((OTP_RESEND_COOL - (Date.now() - user.otpResendAt.getTime())) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSecs} seconds before requesting a new code.` });
    }

    const otp = generateOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: { otpCode: otp, otpExpiry: new Date(Date.now() + OTP_EXPIRY_MS), otpPurpose: 'RESET_PASSWORD', otpResendAt: new Date() }
    });

    sendEmail({
      to: user.email,
      subject: 'Your ConsTradeHire password reset code',
      html: otpEmailHtml(user.name, otp, 'Password Reset')
    }).catch(() => {});

    res.json({
      requiresOtp: true,
      email: user.email,
      masked: maskEmail(user.email)
    });

  } catch (e) {
    console.error('[auth/forgot-password]', e.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ─── RESET PASSWORD ───────────────────────────
// POST /api/auth/reset-password
// Body: { email, otp, password }
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, password } = req.body;
    if (!email || !otp || !password)
      return res.status(400).json({ error: 'Email, code, and new password are required' });

    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and number' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user)
      return res.status(400).json({ error: 'Invalid code or email' });

    if (
      user.otpPurpose !== 'RESET_PASSWORD' ||
      user.otpCode   !== otp.trim() ||
      !user.otpExpiry || user.otpExpiry < new Date()
    ) {
      return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        otpCode: null, otpExpiry: null, otpPurpose: null, otpResendAt: null,
        // Also clear old link-based tokens if any
        passwordResetToken: null, passwordResetExpiry: null
      }
    });

    clearLoginFailures(user.email);
    res.json({ message: 'Password reset successfully. You can now log in.' });

  } catch (e) {
    console.error('[auth/reset-password]', e.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── DELETE ACCOUNT ───────────────────────────
// DELETE /api/auth/account
router.delete('/account', requireAuth, async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.user.id } });
    res.json({ message: 'Account and all data deleted.' });
  } catch (e) {
    console.error('[auth/delete]', e.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ─── VERIFY EMAIL (backward compat link) ─────
// GET /api/auth/verify-email?token=xxx
// Old link-based verification — kept for emails already sent
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/login.html?verifyError=invalid');
    const user = await prisma.user.findFirst({
      where: { emailVerifyToken: token, emailVerifyExpiry: { gt: new Date() } }
    });
    if (!user) return res.redirect('/login.html?verifyError=expired');
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyToken: null, emailVerifyExpiry: null }
    });
    res.redirect('/login.html?verified=1');
  } catch (e) {
    res.redirect('/login.html?verifyError=error');
  }
});

module.exports = router;
