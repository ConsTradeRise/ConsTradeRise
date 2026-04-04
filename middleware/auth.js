// ─────────────────────────────────────────────
//  ConsTradeHire — JWT Auth Middleware
// ─────────────────────────────────────────────

'use strict';
const jwt = require('jsonwebtoken');

// Crash at startup if secret is missing — never fall back to a default
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}

/**
 * Verify JWT and attach user to req.user
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, role, name }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require a specific role
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied — insufficient permissions' });
    }
    next();
  };
}

/**
 * Generate a JWT token — 24h expiry
 */
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );
}

module.exports = { requireAuth, requireRole, generateToken };
