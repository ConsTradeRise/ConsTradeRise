// ============================================================
//  ConsTradeRise — Backend Server
//  Node.js + Express + Prisma
//  Resume parsing + ATS scoring: free, no API credits
//  Job search: Adzuna free API
// ============================================================

'use strict';
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const multer       = require('multer');
const { PrismaClient } = require('@prisma/client');

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

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

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
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — auth routes (strict)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
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

app.use('/api/', apiLimiter);

// ============================================================
//  PLATFORM ROUTES
// ============================================================
app.use('/api/auth',          authLimiter, authRoutes);
app.use('/api/jobs',          jobRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/applications',  applicationRoutes);
app.use('/api/messages',      messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/cover-letter', coverLetterRoutes);

// ============================================================
//  DEDUPLICATION STORE (legacy job cache)
// ============================================================
const DATA_DIR   = path.join(__dirname, 'data');
const DEDUP_FILE = path.join(DATA_DIR, 'seen-jobs.json');
let seenFingerprints = new Set();

function loadDedupStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DEDUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
      seenFingerprints = new Set(data.fingerprints || []);
      console.log(`[dedup] Loaded ${seenFingerprints.size} seen fingerprints.`);
    }
  } catch (e) {
    console.warn('[dedup] Could not load store:', e.message);
  }
}

function saveDedupStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEDUP_FILE, JSON.stringify({
      fingerprints: [...seenFingerprints],
      savedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.warn('[dedup] Could not save store:', e.message);
  }
}

function makeFingerprint(job) {
  return `${job.title || ''}-${job.company || ''}-${job.location || ''}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

// ============================================================
//  IN-MEMORY JOB CACHE (live aggregated jobs)
// ============================================================
let cachedJobs  = [];
let isSearching = false;
let searchPrefs = {
  roles:              ['Construction Estimator', 'Project Coordinator', 'Site Supervisor', 'Civil Engineer'],
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
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

// Combined search — Adzuna + Jooble (runs in parallel)
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

async function runAutoSearch() {
  if (isSearching) return;
  isSearching = true;
  console.log(`\n[auto-search] Starting... ${new Date().toISOString()}`);

  const delay = ms => new Promise(r => setTimeout(r, ms));

  try {
    let newCount = 0;

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

    cachedJobs = cachedJobs.slice(0, 150);
    searchPrefs.lastSearched = new Date().toISOString();
    saveDedupStore();
    console.log(`[auto-search] Done — ${newCount} new, ${cachedJobs.length} cached.`);
  } catch (e) {
    console.error('[auto-search] Error:', e.message);
  }
  isSearching = false;
}

// ============================================================
//  LIVE JOB ENDPOINTS
// ============================================================
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
    res.status(500).json({ error: e.message });
  }
});

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

// ─── RESUME FILE UPLOAD + PARSE ──────────────
// POST /api/resume/upload  (multipart/form-data, field: "resume")
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
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

app.post('/api/resume/upload', requireAuth, upload.single('resume'), async (req, res) => {
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

      // Store resume record (keep last 5 per user)
      await prisma.resume.create({
        data: {
          userId:      req.user.id,
          name:        req.file.originalname,
          content:     text.substring(0, 10000),
          aiGenerated: false
        }
      });

      profileSaved = true;
    } catch (dbErr) {
      console.warn('[resume/upload] profile save failed:', dbErr.message);
    }

    res.json({ parsed, rawText: text.substring(0, 3000), profileSaved });

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
app.get('/api/preferences', (req, res) => res.json(searchPrefs));
app.post('/api/preferences', (req, res) => {
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
//  START
// ============================================================
loadDedupStore();

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   ConsTradeRise — Construction Job Platform  ║');
  console.log('║   http://localhost:' + PORT + '                      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Routes:');
  console.log('  POST /api/auth/register');
  console.log('  POST /api/auth/login');
  console.log('  GET  /api/jobs');
  console.log('  POST /api/jobs');
  console.log('  POST /api/ats/score');
  console.log('');
  console.log('  Auto-searching for jobs in 5 seconds...');
  setTimeout(runAutoSearch, 5000);
});

const INTERVAL_MS = (searchPrefs.autoSearchInterval || 4) * 60 * 60 * 1000;
setInterval(runAutoSearch, INTERVAL_MS);
