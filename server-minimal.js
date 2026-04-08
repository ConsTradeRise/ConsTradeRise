// ============================================================
//  ConsTradeHire — Minimal Server (Supabase Architecture)
//  Responsibilities:
//    1. Serve static files
//    2. Inject Supabase URL + anon key into HTML (no secrets exposed)
//    3. Admin-only routes (ban/delete users via service role)
//    4. Proxy to Supabase edge functions for local dev
//  ALL auth, data, and AI logic → Supabase + Edge Functions
// ============================================================

'use strict';
require('dotenv').config();

const express    = require('express');
const compression= require('compression');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const https      = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL  = process.env.SUPABASE_URL  || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || '';

// ─── Middleware ───────────────────────────────
app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'esm.sh', 'cdn.skypack.dev'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:    ["'self'", 'fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", SUPABASE_URL, '*.supabase.co', 'https://api.adzuna.com'],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use('/api/', apiLimiter);

// ─── Inject Supabase config into HTML ─────────
// Replaces static files by injecting window.__SUPABASE_URL__ + __SUPABASE_ANON__
// This exposes ONLY the anon key (safe — controlled by RLS)
const fs = require('fs');
const PUBLIC = path.join(__dirname, 'public');

function injectConfig(html) {
  const script = `<script>
    window.__SUPABASE_URL__  = ${JSON.stringify(SUPABASE_URL)};
    window.__SUPABASE_ANON__ = ${JSON.stringify(SUPABASE_ANON)};
  </script>`;
  return html.replace('</head>', `${script}\n</head>`);
}

// Serve HTML with injected config
app.get('*.html', (req, res) => {
  const file = path.join(PUBLIC, req.path);
  if (!fs.existsSync(file)) return res.status(404).sendFile(path.join(PUBLIC, '404.html'));
  try {
    const html = fs.readFileSync(file, 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(injectConfig(html));
  } catch {
    res.sendFile(file);
  }
});

// Serve other static files normally
app.use(express.static(PUBLIC, { maxAge: '1h', etag: true, lastModified: true }));

// ─── SEO ─────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://constradehire.com/sitemap.xml'
  );
});

// ─── Admin API (service role only) ───────────
// These require x-admin-secret header (never exposed to frontend)
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20 });

function requireAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function supabaseServiceCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = `${SUPABASE_URL}/rest/v1${path}`;
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
        ...(data && { 'Content-Length': Buffer.byteLength(data) })
      }
    };
    const req = https.request(options, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Ban user
app.post('/api/admin/ban/:userId', adminLimiter, requireAdminSecret, async (req, res) => {
  try {
    await supabaseServiceCall('PATCH', `/users?id=eq.${req.params.userId}`, {
      name: `[BANNED] ${req.body.name || 'User'}`
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete user
app.delete('/api/admin/user/:userId', adminLimiter, requireAdminSecret, async (req, res) => {
  try {
    await supabaseServiceCall('DELETE', `/users?id=eq.${req.params.userId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activate/deactivate job
app.patch('/api/admin/job/:jobId', adminLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { isActive } = req.body;
    await supabaseServiceCall('PATCH', `/jobs?id=eq.${req.params.jobId}`, { isActive });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Catch-all → index.html ──────────────────
app.get('*', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(injectConfig(html));
  } catch {
    res.sendFile(path.join(PUBLIC, 'index.html'));
  }
});

// ─── Start ────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   ConsTradeHire — Supabase Architecture      ║');
    console.log(`║   http://localhost:${PORT}                      ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('  Auth + Data  → Supabase (RLS enforced)');
    console.log('  AI + Files   → Supabase Edge Functions');
    console.log('  Admin only   → This server (service role)');
  });
}

module.exports = app;
