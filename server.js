// ============================================================
//  ConsTradeHire — Backend Server
//  Node.js + Express + Prisma
//  Resume parsing + ATS scoring: free, no API credits
//  Job search: Adzuna free API
// ============================================================

'use strict';
require('dotenv').config();

const express      = require('express');
const compression  = require('compression');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const multer       = require('multer');
const prisma = require('./utils/prisma');

// Free utilities — no AI credits
const { parseResume } = require('./utils/resumeParser');
const { scoreATS }    = require('./utils/atsScorer');

// Auth middleware
const { requireAuth } = require('./middleware/auth');

// Route handlers
const authRoutes          = require('./routes/auth');
const jobRoutes           = require('./routes/jobs');
const profileRoutes       = require('./routes/profile');
const applicationRoutes   = require('./routes/applications');
const messageRoutes       = require('./routes/messages');
const notificationRoutes  = require('./routes/notifications');
const adminRoutes         = require('./routes/admin');
const coverLetterRoutes   = require('./routes/coverLetter');
const externalRoutes      = require('./routes/external');
const alertRoutes         = require('./routes/alerts');
const interviewRoutes     = require('./routes/interviews');
const workerRoutes        = require('./routes/workers');
const reviewRoutes        = require('./routes/reviews');
const analyticsRoutes     = require('./routes/analytics');
const resumeRoutes        = require('./routes/resumes');
const { sendJobDigest, sendEmail, baseTemplate } = require('./utils/email');

const app  = express();
const PORT = process.env.PORT || 3000;

// Supabase storage — for resume file uploads
let supabaseAdmin = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    });
  }
} catch (_) { /* supabase-js not installed */ }

// Claude client — only used for premium AI features (cover letter, interview prep, etc.)
// Set ANTHROPIC_API_KEY in .env to enable; leave blank to disable premium features
let client = null;
const MODEL = 'claude-sonnet-4-6';
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (_) { /* SDK not installed — premium features disabled */ }

// ============================================================
//  MIDDLEWARE
// ============================================================

// Trust Vercel's proxy (required for rate limiting to work correctly)
app.set('trust proxy', 1);
app.use(compression()); // gzip all responses

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdn.tailwindcss.com', 'https://esm.sh'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'https://cdn.tailwindcss.com'],
      fontSrc:        ["'self'", 'fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", 'https://api.adzuna.com', 'https://esm.sh', 'https://*.supabase.co'],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false
}));

// CORS — allow production domains + any vercel.app preview + localhost
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin, no-origin (curl/mobile), constradehire.com, vercel previews, localhost
    if (
      !origin ||
      origin === 'https://constradehire.com' ||
      origin === 'https://www.constradehire.com' ||
      origin.endsWith('.vercel.app') ||
      origin.startsWith('http://localhost')
    ) return cb(null, true);
    cb(new Error('CORS policy: origin not allowed'));
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',      // cache CSS/JS/images for 1 hour
  etag: true,
  lastModified: true
}));

// Rate limiting — login (20 attempts / 15 min per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiting — register (10 registrations / hour per IP)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiting — AI routes (moderate)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'AI rate limit reached. Please wait a moment.' }
});

// Rate limiting — general API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' }
});

// Rate limiting — messages (prevent spam: 10 per minute per user)
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Too many messages. Please wait before sending again.' }
});

// Rate limiting — job reports (5 per hour per user)
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Too many reports submitted. Please try again later.' }
});

app.use('/api/', apiLimiter);

// ============================================================
//  PLATFORM ROUTES
// ============================================================
app.post('/api/auth/login',    loginLimiter);
app.post('/api/auth/register', registerLimiter);
app.use('/api/auth',          authRoutes);

// Live job endpoints MUST be registered before jobRoutes to avoid /:id catching them
app.get('/api/jobs/live', (req, res) => {
  res.json({ jobs: cachedJobs, lastSearched: searchPrefs.lastSearched, isSearching, newCount: cachedJobs.filter(j => j.isNew).length });
});
app.post('/api/jobs/search', aiLimiter, async (req, res) => {
  const { role, location } = req.body;
  if (!role) return res.status(400).json({ error: 'role is required' });
  try {
    const jobs = await searchJobsWithAI(role, location || searchPrefs.location);
    const tagged = jobs.map(job => {
      const fp = makeFingerprint(job);
      job.isNew = !seenFingerprints.has(fp);
      job.fingerprint = fp;
      job.id = `live-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      if (job.isNew) seenFingerprints.add(fp);
      if (!cachedJobs.some(c => c.fingerprint === fp)) cachedJobs.unshift(job);
      return job;
    });
    cachedJobs = cachedJobs.slice(0, 150);
    saveDedupStore();
    res.json({ jobs: tagged, total: tagged.length });
  } catch (e) {
    res.status(500).json({ error: e.message }); }
});

app.use('/api/jobs',          jobRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/applications',  applicationRoutes);
app.use('/api/messages',      messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/cover-letter', coverLetterRoutes);
app.use('/api/alerts',      alertRoutes);
app.use('/api/interviews',  interviewRoutes);
app.use('/api/workers',     workerRoutes);
app.use('/api/reviews',     reviewRoutes);
app.use('/api/analytics',   analyticsRoutes);
app.use('/api/resumes',     resumeRoutes);
app.use('/api',             externalRoutes);

// ============================================================
//  SEO — robots.txt + sitemap.xml
// ============================================================

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(
    'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /dashboard.html\nDisallow: /admin.html\n\nSitemap: https://constradehire.com/sitemap.xml'
  );
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { isActive: true },
      select: { id: true, updatedAt: true },
      orderBy: { postedAt: 'desc' },
      take: 1000
    });

    const base = 'https://constradehire.com';
    const staticUrls = [
      { loc: `${base}/`,             changefreq: 'daily',   priority: '1.0' },
      { loc: `${base}/jobs.html`,    changefreq: 'hourly',  priority: '0.9' },
      { loc: `${base}/register.html`,changefreq: 'monthly', priority: '0.5' },
      { loc: `${base}/login.html`,   changefreq: 'monthly', priority: '0.4' },
    ];

    const jobUrls = jobs.map(j => ({
      loc:        `${base}/jobs.html?id=${j.id}`,
      lastmod:    j.updatedAt.toISOString().split('T')[0],
      changefreq: 'weekly',
      priority:   '0.7'
    }));

    const toTag = ({ loc, lastmod, changefreq, priority }) =>
      `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticUrls, ...jobUrls].map(toTag).join('\n')}\n</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (e) {
    res.status(500).send('<?xml version="1.0"?><urlset/>');
  }
});

// ============================================================
//  DEDUPLICATION — DB-backed via externalUrl uniqueness
//  In-memory Set is a fast cache; DB is the source of truth
//  and survives process restarts / Railway redeploys.
// ============================================================
let seenFingerprints = new Set();

async function loadDedupStore() {
  try {
    const existing = await prisma.job.findMany({
      where: { source: 'API', externalUrl: { not: null } },
      select: { externalUrl: true }
    });
    seenFingerprints = new Set(existing.map(j => j.externalUrl));
    console.log(`[dedup] Loaded ${seenFingerprints.size} seen URLs from DB.`);
  } catch (e) {
    console.warn('[dedup] Could not load from DB:', e.message);
  }
}

// saveDedupStore is no longer needed — DB writes happen in persistLiveJobsToDB
function saveDedupStore() {}

function makeFingerprint(job) {
  // Prefer stable externalUrl; fall back to title+company+location slug
  if (job.externalUrl || job.url) return (job.externalUrl || job.url).slice(0, 500);
  return `${job.title || ''}-${job.company || ''}-${job.location || ''}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

// ============================================================
//  IN-MEMORY JOB CACHE (live aggregated jobs)
// ============================================================
let cachedJobs  = [];
let isSearching = false;
let searchPrefs = {
  roles: [
    // Management & Coordination
    'Construction Estimator', 'Project Coordinator', 'Project Manager', 'Construction Manager',
    'Site Supervisor', 'Site Superintendent', 'Field Superintendent',
    // Engineering & Design
    'Civil Engineer', 'Structural Engineer', 'Mechanical Engineer', 'BIM Coordinator', 'Quantity Surveyor',
    // Skilled Trades
    'Carpenter', 'Electrician', 'Plumber', 'HVAC Technician', 'Welder',
    'Ironworker', 'Heavy Equipment Operator', 'Crane Operator', 'Pipefitter',
    // Safety & Compliance
    'Construction Safety Officer', 'Health and Safety Coordinator',
    // Labour
    'General Labourer', 'Construction Worker'
  ],
  location:           'Ontario, Canada',
  autoSearchInterval: 4,
  lastSearched:       null
};

// ============================================================
//  JOB SEARCH — Adzuna Free API (no AI credits)
//  Sign up free at: https://developer.adzuna.com
//  Add to .env:  ADZUNA_APP_ID=xxx  ADZUNA_API_KEY=xxx
// ============================================================

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function searchJobsWithAdzuna(role, location) {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_API_KEY;

  if (!appId || !appKey) {
    console.warn('[search] Adzuna keys not set — add ADZUNA_APP_ID + ADZUNA_API_KEY to .env');
    return [];
  }

  const what  = encodeURIComponent(role);
  const where = encodeURIComponent(location.replace(', Canada', '').trim());
  const url   = `https://api.adzuna.com/v1/api/jobs/ca/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=10&what=${what}&where=${where}&content-type=application/json`;

  try {
    const data = await httpGet(url);
    const jobs = (data.results || []).map(j => ({
      title:    j.title,
      company:  j.company?.display_name || 'Unknown',
      location: j.location?.display_name || location,
      salary:   j.salary_min ? `$${Math.round(j.salary_min / 1000)}k–$${Math.round((j.salary_max || j.salary_min) / 1000)}k` : null,
      type:     j.contract_time || 'Full-time',
      source:   'Adzuna',
      posted:   j.created,
      url:      j.redirect_url,
      summary:  j.description ? j.description.substring(0, 300) : ''
    }));
    return jobs.filter(j => j.title && j.company);
  } catch (e) {
    console.error(`[search] Adzuna failed for "${role}":`, e.message);
    return [];
  }
}

// ─── Jooble API (free, no credits needed) ────
// Sign up free at: https://jooble.org/api/employer
// Add to .env: JOOBLE_API_KEY=xxx
async function searchJobsWithJooble(keywords, location) {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) return [];

  return new Promise((resolve) => {
    const body = JSON.stringify({ keywords, location, page: 1 });
    const options = {
      hostname: 'jooble.org',
      path: `/api/${encodeURIComponent(key)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (jRes) => {
      let data = '';
      jRes.on('data', chunk => data += chunk);
      jRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const jobs = (json.jobs || []).slice(0, 10).map(j => ({
            title:    j.title   || '',
            company:  j.company || 'Company',
            location: j.location || location,
            salary:   j.salary  || null,
            type:     'Full-time',
            source:   'Jooble',
            posted:   j.updated,
            url:      j.link    || null,
            summary:  j.snippet ? j.snippet.substring(0, 300) : ''
          }));
          resolve(jobs.filter(j => j.title));
        } catch { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

// ─── Apify Indeed Canada scraper ─────────────────────────────
// Add to .env: APIFY_TOKEN=xxx  APIFY_DATASET_ID=xxx
async function fetchApifyDataset() {
  const token     = process.env.APIFY_TOKEN;
  const datasetId = process.env.APIFY_DATASET_ID;
  if (!token || !datasetId) return [];

  try {
    const data = await httpGet(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=100&clean=true`
    );
    const items = Array.isArray(data) ? data : (data.items || []);
    return items.map(j => ({
      title:    j.positionName || j.title || '',
      company:  j.company      || 'Unknown',
      location: j.location     || 'Canada',
      salary:   j.salary       || null,
      type:     j.jobType      || 'Full-time',
      source:   'Indeed (CA)',
      posted:   j.postingDateParsed || j.postedAt || null,
      url:      j.externalApplyLink || j.url || null,
      summary:  j.description ? j.description.substring(0, 300) : ''
    })).filter(j => j.title);
  } catch (e) {
    console.error('[search] Apify dataset fetch failed:', e.message);
    return [];
  }
}

async function triggerApifyRun() {
  const token   = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID || 'hMvNSpz3JnHgl5jkh';
  if (!token) return;

  const body = JSON.stringify({
    country: 'ca',
    position: 'construction',
    location: 'Canada',
    maxItems: 100
  });

  const options = {
    hostname: 'api.apify.com',
    path: `/v2/acts/${actorId}/runs?token=${token}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const run = JSON.parse(d);
          console.log('[apify] New run triggered:', run.data?.id);
        } catch {}
        resolve();
      });
    });
    req.on('error', (e) => { console.warn('[apify] Trigger failed:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// Combined search — Adzuna + Jooble + Apify Indeed (runs in parallel)
async function searchAllSources(role, location) {
  const [adzunaJobs, joobleJobs] = await Promise.allSettled([
    searchJobsWithAdzuna(role, location),
    searchJobsWithJooble(role, location)
  ]);
  return [
    ...(adzunaJobs.status === 'fulfilled' ? adzunaJobs.value : []),
    ...(joobleJobs.status  === 'fulfilled' ? joobleJobs.value  : [])
  ];
}

// Alias used by auto-search
const searchJobsWithAI = searchAllSources;

// Save live (external) jobs to DB so they survive Vercel serverless restarts.
// Uses externalUrl as the unique key — upserts to avoid duplicates.
async function persistLiveJobsToDB(jobs) {
  if (!jobs?.length) return;
  let saved = 0;
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4-hour TTL
  for (const job of jobs.slice(0, 100)) {
    const url = job.url || job.externalUrl;
    if (!url) continue;
    try {
      const existing = await prisma.job.findFirst({ where: { externalUrl: url }, select: { id: true } });
      if (existing) {
        await prisma.job.update({ where: { id: existing.id }, data: { isActive: true, expiresAt } });
      } else {
        await prisma.job.create({ data: {
          title:       (job.title       || 'Construction Job').substring(0, 200),
          description: (job.description || job.summary || job.title || '').substring(0, 5000),
          location:    (job.location    || job.city   || 'Canada').substring(0, 200),
          city:        (job.city        || '').substring(0, 100),
          province:    (job.province    || '').substring(0, 100),
          salary:      (job.salary      || '').substring(0, 100) || null,
          jobType:     (job.type        || job.jobType || 'Full-time').substring(0, 50),
          companyName: (job.company     || job.companyName || 'Company').substring(0, 200),
          skills:      Array.isArray(job.skills) ? job.skills.slice(0, 20) : [],
          source:      'API',
          externalUrl: url.substring(0, 500),
          isActive:    true,
          expiresAt
        }});
        saved++;
      }
    } catch (_) {}
  }
  if (saved) console.log(`[persist] Saved ${saved} live jobs to DB.`);
}

async function runAutoSearch() {
  if (isSearching) return;
  isSearching = true;
  console.log(`\n[auto-search] Starting... ${new Date().toISOString()}`);

  const delay = ms => new Promise(r => setTimeout(r, ms));

  try {
    let newCount = 0;

    // Pull latest Apify Indeed dataset first
    const apifyJobs = await fetchApifyDataset();
    for (const job of apifyJobs) {
      const fp = makeFingerprint(job);
      job.isNew       = !seenFingerprints.has(fp);
      job.fingerprint = fp;
      job.id          = `live-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      job.searchedAt  = new Date().toISOString();
      if (job.isNew) { seenFingerprints.add(fp); newCount++; }
      if (!cachedJobs.some(c => c.fingerprint === fp)) cachedJobs.unshift(job);
    }
    if (apifyJobs.length) console.log(`[auto-search] Apify: ${apifyJobs.length} jobs pulled.`);

    // Search one role at a time with 2s gap to avoid Adzuna 429
    for (const role of searchPrefs.roles) {
      try {
        const jobs = await searchJobsWithAI(role, searchPrefs.location);
        for (const job of jobs) {
          const fp = makeFingerprint(job);
          job.isNew       = !seenFingerprints.has(fp);
          job.fingerprint = fp;
          job.id          = `live-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
          job.searchedAt  = new Date().toISOString();
          if (job.isNew) { seenFingerprints.add(fp); newCount++; }
          if (!cachedJobs.some(c => c.fingerprint === fp)) cachedJobs.unshift(job);
        }
      } catch (e) {
        console.warn(`[auto-search] Skipped "${role}":`, e.message);
      }
      await delay(2000); // 2 second pause between requests
    }

    cachedJobs = cachedJobs.slice(0, 250);
    searchPrefs.lastSearched = new Date().toISOString();
    saveDedupStore();
    console.log(`[auto-search] Done — ${newCount} new, ${cachedJobs.length} cached.`);

    // Persist new live jobs to DB so Vercel serverless instances can serve them
    if (newCount > 0) persistLiveJobsToDB(cachedJobs.filter(j => j.isNew)).catch(() => {});

    // Trigger fresh Apify run for next cycle (fire-and-forget)
    triggerApifyRun().catch(() => {});
  } catch (e) {
    console.error('[auto-search] Error:', e.message);
  }
  isSearching = false;
}

// ============================================================
//  AI ENDPOINTS
// ============================================================

// ── Premium AI guard ─────────────────────────────────────────
function requireAI(req, res, next) {
  if (!client) return res.status(503).json({ error: 'AI features require ANTHROPIC_API_KEY in .env' });
  next();
}

// Resume generation / tailoring
app.post('/api/resume', aiLimiter, requireAI, async (req, res) => {
  const { systemPrompt, userPrompt, maxTokens } = req.body;
  if (!userPrompt) return res.status(400).json({ error: 'userPrompt required' });
  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: maxTokens || 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    res.json({ content: response.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── COVER LETTER FILE UPLOAD (text extract only) ────────────
// POST /api/applications/cover-letter/upload  — returns extracted text
const uploadCL = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ['.pdf','.doc','.docx'].includes(ext)) cb(null, true);
    else cb(new Error('Only PDF and Word files are allowed'));
  }
});
app.post('/api/applications/cover-letter/upload', requireAuth, (req, res, next) => {
  uploadCL.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large. Max 4MB.' : err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    let text = '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.pdf' || req.file.mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    }
    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Could not extract text from file.' });
    }
    res.json({ text: text.trim().substring(0, 5000) });
  } catch (e) {
    console.error('[cover-letter/upload]', e.message);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

// ─── RESUME FILE UPLOAD + PARSE ──────────────
// POST /api/resume/upload  (multipart/form-data, field: "resume")
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB — stays under Vercel's 4.5MB request limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const allowedExt = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word (.docx) files are allowed'));
    }
  }
});

app.post('/api/resume/upload', requireAuth, (req, res, next) => {
  upload.single('resume')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File too large. Maximum size is 4MB.'
        : err.message || 'Upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let text = '';
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.pdf' || req.file.mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract text from file. Please try a different file.' });
    }

    // ── Free rule-based parsing — zero API credits ────────
    const parsed = parseResume(text);

    // ── Auto-save parsed data to user profile ─────────────
    let profileSaved = false;
    let fileUrl = null;
    try {
      const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
      const rawCity = parsed.city || '';
      const cityParts = rawCity.split(',');
      const city     = cityParts[0]?.trim() || '';
      const province = cityParts[1]?.trim() || '';

      const profileData = {};
      if (parsed.phone)           profileData.phone           = parsed.phone;
      if (parsed.email)           profileData.email           = parsed.email;
      if (parsed.linkedin)        profileData.linkedin        = parsed.linkedin;
      if (parsed.headline)        profileData.headline        = parsed.headline;
      if (parsed.summary)         profileData.summary         = parsed.summary;
      if (parsed.yearsExperience) profileData.yearsExperience = parsed.yearsExperience;
      if (parsed.availability)    profileData.availability    = parsed.availability;
      if (parsed.driversLicence)  profileData.driversLicence  = parsed.driversLicence;
      if (parsed.openToRelocation !== undefined) profileData.openToRelocation = parsed.openToRelocation;
      if (city)     profileData.city     = city;
      if (province) profileData.province = province;
      if (rawCity)  profileData.location = rawCity;
      if (skills.length)          profileData.skills          = skills;
      if (parsed.skillCategories) profileData.skillCategories = parsed.skillCategories;
      if (Array.isArray(parsed.experiences)    && parsed.experiences.length)    profileData.experiences    = parsed.experiences;
      if (Array.isArray(parsed.educations)     && parsed.educations.length)     profileData.educations     = parsed.educations;
      if (Array.isArray(parsed.certifications) && parsed.certifications.length) profileData.certifications = parsed.certifications;

      await prisma.profile.upsert({
        where:  { userId: req.user.id },
        update: profileData,
        create: { userId: req.user.id, ...profileData }
      });

      // Upload file to Supabase storage if configured
      if (supabaseAdmin) {
        try {
          const ext      = path.extname(req.file.originalname).toLowerCase();
          const filePath = `${req.user.id}/${Date.now()}${ext}`;
          const { error: upErr } = await supabaseAdmin.storage
            .from('resumes')
            .upload(filePath, req.file.buffer, {
              contentType: req.file.mimetype,
              upsert: false
            });
          if (!upErr) {
            const { data: urlData } = supabaseAdmin.storage.from('resumes').getPublicUrl(filePath);
            fileUrl = urlData?.publicUrl || null;
          }
        } catch (_) { /* storage optional */ }
      }

      // Store resume record (keep last 5 per user)
      await prisma.resume.create({
        data: {
          userId:      req.user.id,
          name:        req.file.originalname,
          content:     text.substring(0, 10000),
          fileUrl:     fileUrl,
          aiGenerated: false
        }
      });

      profileSaved = true;
    } catch (dbErr) {
      console.warn('[resume/upload] profile save failed:', dbErr.message);
    }

    res.json({ parsed, rawText: text.substring(0, 3000), profileSaved, fileUrl: fileUrl || null });

  } catch (e) {
    console.error('[resume/upload]', e.message);
    res.status(500).json({ error: 'Failed to parse resume: ' + e.message });
  }
});

// Resume parsing (text-based, free)
app.post('/api/parse-resume', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const parsed = parseResume(text);
    res.json({ parsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ATS scoring — free keyword matching, no API credits
app.post('/api/ats/score', requireAuth, async (req, res) => {
  const { resumeText, jobDescription, userId, jobId, resumeId } = req.body;
  if (!resumeText || !jobDescription) {
    return res.status(400).json({ error: 'resumeText and jobDescription required' });
  }

  try {
    // ── Free keyword-based scoring ────────────────────────
    const result = scoreATS(resumeText, jobDescription);

    // Store in DB if userId + jobId provided
    if (userId && jobId) {
      try {
        await prisma.atsResult.upsert({
          where:  { userId_jobId_resumeId: { userId, jobId, resumeId: resumeId || null } },
          update: { ...result },
          create: { userId, jobId, resumeId: resumeId || null, ...result }
        });
      } catch (dbErr) {
        console.warn('[ats] DB store failed:', dbErr.message);
      }
    }

    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Experience bullet rewriter (premium)
app.post('/api/exp-bullets', aiLimiter, requireAI, async (req, res) => {
  const { systemPrompt, userPrompt, maxTokens } = req.body;
  if (!userPrompt) return res.status(400).json({ error: 'userPrompt required' });
  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: maxTokens || 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    res.json({ content: response.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cover letter generation
app.post('/api/cover-letter', aiLimiter, requireAI, async (req, res) => {
  const { systemPrompt, userPrompt, maxTokens } = req.body;
  if (!userPrompt) return res.status(400).json({ error: 'userPrompt required' });
  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: maxTokens || 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    res.json({ content: response.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Interview prep
app.post('/api/interview-prep', aiLimiter, requireAI, async (req, res) => {
  const { jobTitle, company, jobDesc, candidateName, role, skills } = req.body;
  const system = `You are a Canadian construction industry interview coach. Generate 8 targeted interview questions with strong model answers.`;
  const userContent = `Candidate: ${candidateName || 'Candidate'} — ${role || 'Construction Professional'}
Skills: ${skills || 'Construction skills'}
Job: ${jobTitle || 'Position'} at ${company || 'Company'}
Description: ${(jobDesc || '').substring(0, 1500)}

Generate 8 interview Q&A pairs. Format:
Q: [question]
A: [2-3 sentence answer with specific examples]`;

  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 2000, system,
      messages: [{ role: 'user', content: userContent }]
    });
    res.json({ content: response.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Follow-up email
app.post('/api/follow-up', aiLimiter, requireAI, async (req, res) => {
  const { candidateName, jobTitle, company, interviewDate, interviewerName } = req.body;
  const system = `You are a professional career coach. Write a concise post-interview follow-up email for a Canadian construction professional.`;
  const userContent = `Write a follow-up email:
Candidate: ${candidateName || 'Candidate'}
Job: ${jobTitle || 'Position'} at ${company || 'Company'}
Interview date: ${interviewDate || 'recently'}
Interviewer: ${interviewerName || 'Hiring Manager'}
Requirements: Under 150 words, professional tone, reiterate interest, clear call to action.`;

  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 400, system,
      messages: [{ role: 'user', content: userContent }]
    });
    res.json({ content: response.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  PREFERENCES
// ============================================================
app.get('/api/preferences', apiLimiter, (req, res) => res.json(searchPrefs));
app.post('/api/preferences', apiLimiter, requireAuth, (req, res) => {
  const { roles, location, autoSearchInterval } = req.body;
  if (Array.isArray(roles))   searchPrefs.roles = roles;
  if (location)               searchPrefs.location = location;
  if (autoSearchInterval)     searchPrefs.autoSearchInterval = autoSearchInterval;
  res.json({ ok: true, prefs: searchPrefs });
});

// ============================================================
//  CATCH-ALL — serve index.html
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
//  START (local dev) / EXPORT (Vercel serverless)
// ============================================================
loadDedupStore(); // async — populates seenFingerprints from DB before first auto-search

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   ConsTradeHire — Construction Job Platform  ║');
    console.log('║   http://localhost:' + PORT + '                      ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('  Auto-searching for jobs in 5 seconds...');
    setTimeout(runAutoSearch, 5000);
  });

  const INTERVAL_MS = (searchPrefs.autoSearchInterval || 4) * 60 * 60 * 1000;
  setInterval(runAutoSearch, INTERVAL_MS);

  // Daily job digest — 8 AM every day
  async function sendDailyDigest() {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const newJobs = await prisma.job.findMany({
        where: { isActive: true, postedAt: { gte: since } },
        orderBy: { postedAt: 'desc' },
        take: 5,
        select: { title: true, companyName: true, location: true, salary: true, externalUrl: true, id: true }
      });
      if (newJobs.length === 0) return;

      const workers = await prisma.user.findMany({
        where: { role: 'WORKER', profile: { openToMatching: true } },
        select: { email: true, name: true }
      });

      console.log(`[digest] Sending ${newJobs.length} jobs to ${workers.length} workers`);
      for (const w of workers) {
        await sendJobDigest({ to: w.email, workerName: w.name, jobs: newJobs });
      }
    } catch (e) {
      console.error('[digest] Error:', e.message);
    }
  }

  // Schedule at 8 AM daily
  function scheduleDigest() {
    const now = new Date();
    const next8AM = new Date(now);
    next8AM.setHours(8, 0, 0, 0);
    if (next8AM <= now) next8AM.setDate(next8AM.getDate() + 1);
    const msUntil = next8AM - now;
    setTimeout(() => {
      sendDailyDigest();
      setInterval(sendDailyDigest, 24 * 60 * 60 * 1000);
    }, msUntil);
    console.log(`[digest] Scheduled for ${next8AM.toLocaleTimeString()}`);
  }
  scheduleDigest();

  // Auto-expire: deactivate jobs past their expiresAt (runs every 6 hours)
  async function expireOldJobs() {
    try {
      const { count } = await prisma.job.updateMany({
        where: { isActive: true, expiresAt: { lt: new Date() } },
        data: { isActive: false }
      });
      if (count > 0) console.log(`[expire] Deactivated ${count} expired job(s).`);
    } catch (e) {
      console.error('[expire] Error:', e.message);
    }
  }
  setTimeout(expireOldJobs, 10000);
  setInterval(expireOldJobs, 6 * 60 * 60 * 1000);
}

// ─── JOB ALERTS ──────────────────────────────────────────────
// Called after a new DB job is created (from POST /api/jobs)
// Finds matching active alerts, creates Notifications + sends emails
async function triggerJobAlerts(job) {
  try {
    const alerts = await prisma.jobAlert.findMany({
      where: { active: true },
      include: { user: { select: { id: true, name: true, email: true } } }
    });

    for (const alert of alerts) {
      // Skip if the alert belongs to the job poster
      if (alert.userId === job.employerId) continue;

      // Keyword match (any keyword in title/description)
      const keywords = alert.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
      const haystack = `${job.title} ${job.description || ''} ${job.companyName || ''}`.toLowerCase();
      const matches  = keywords.some(kw => haystack.includes(kw));
      if (!matches) continue;

      // Province match (if set)
      if (alert.province && job.city && !`${job.city} ${job.location || ''}`.toLowerCase().includes(alert.province.toLowerCase())) continue;

      // JobType match (if set)
      if (alert.jobType && job.jobType && !job.jobType.toLowerCase().includes(alert.jobType.toLowerCase())) continue;

      // Create in-app notification
      await prisma.notification.create({
        data: {
          userId: alert.user.id,
          type:   'new_job',
          title:  `New job match: ${job.title}`,
          body:   `${job.companyName || 'A company'} is hiring in ${job.city || job.location || 'Canada'}`,
          link:   `/job.html?id=${job.id}`,
          read:   false
        }
      }).catch(() => {});

      // Send email (fire-and-forget)
      if (alert.user.email) {
        const html = baseTemplate('New Job Match', `
          <p>Hi ${alert.user.name || 'there'},</p>
          <p>A new job matching your alert <strong>"${alert.keywords}"</strong> has been posted:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;font-weight:bold;color:#374151;width:100px;">Role</td><td style="padding:8px;">${job.title}</td></tr>
            <tr style="background:#f9fafb;"><td style="padding:8px;font-weight:bold;color:#374151;">Company</td><td style="padding:8px;">${job.companyName || 'Company'}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;color:#374151;">Location</td><td style="padding:8px;">${job.city || job.location || 'Canada'}</td></tr>
            ${job.salary ? `<tr style="background:#f9fafb;"><td style="padding:8px;font-weight:bold;color:#374151;">Salary</td><td style="padding:8px;">${job.salary}</td></tr>` : ''}
          </table>
          <a href="https://constradehire.com/job.html?id=${job.id}" style="display:inline-block;background:#f97316;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px;">View Job →</a>
          <p style="margin-top:20px;font-size:12px;color:#9ca3af;">Manage your job alerts in your <a href="https://constradehire.com/dashboard.html" style="color:#f97316;">dashboard</a>.</p>
        `);
        sendEmail({ to: alert.user.email, subject: `Job Alert: ${job.title} at ${job.companyName || 'Company'}`, html }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[job-alerts] trigger error:', e.message);
  }
}

// Attach to app so routes/jobs.js can call app.triggerJobAlerts(job)
app.triggerJobAlerts = triggerJobAlerts;

module.exports = app;
