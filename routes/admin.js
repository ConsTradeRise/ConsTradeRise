// ─────────────────────────────────────────────
//  ConsTradeHire — Admin Routes (ADMIN role only)
//  GET  /api/admin/stats
//  GET  /api/admin/users
//  PUT  /api/admin/users/:id/ban
//  DELETE /api/admin/users/:id
//  GET  /api/admin/jobs
//  PUT  /api/admin/jobs/:id/toggle
//  DELETE /api/admin/jobs/:id
//  GET  /api/admin/applications
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const https   = require('https');
const prisma  = require('../utils/prisma');
const { requireAuth, requireRole, generateToken } = require('../middleware/auth');

// ─── Company names to scrape via Adzuna ──────────
const SCRAPE_COMPANIES = [
  'PCL Construction', 'EllisDon', 'Aecon', 'Graham Construction', 'Bird Construction',
  'Ledcor', 'Pomerleau', 'Chandos Construction', 'Bondfield Construction', 'Buttcon',
  'Eastern Construction', 'Taggart Construction', 'Maple Reinders', 'Kenaidan',
  'Vanbots Construction', 'M. Sullivan & Son', 'Clark Construction',
  'Skanska Canada', 'Turner Construction', 'AECOM', 'Stantec',
  'Mattamy Homes', 'Great Gulf', 'Menkes', 'Ainsworth',
  'Johnson Controls', 'Williams Mechanical', 'Pivot Electric',
  'Miller Group', 'R.V. Anderson', 'Priestly Demolition',
  'Coco Paving', 'Lafarge Canada', 'Surespan', 'Hard Rock',
  'Dufferin Concrete', 'Smith Brothers & Wilson'
];

// Province abbreviation map for Canadian locations
const PROV_MAP = {
  'ontario': 'ON', 'british columbia': 'BC', 'alberta': 'AB', 'quebec': 'QC',
  'manitoba': 'MB', 'saskatchewan': 'SK', 'nova scotia': 'NS',
  'new brunswick': 'NB', 'newfoundland': 'NL', 'prince edward island': 'PE',
  'northwest territories': 'NT', 'nunavut': 'NU', 'yukon': 'YT',
  'toronto': 'ON', 'vancouver': 'BC', 'calgary': 'AB', 'edmonton': 'AB',
  'montreal': 'QC', 'ottawa': 'ON', 'winnipeg': 'MB', 'hamilton': 'ON',
  'kitchener': 'ON', 'london': 'ON', 'mississauga': 'ON', 'brampton': 'ON',
  'markham': 'ON', 'vaughan': 'ON', 'surrey': 'BC', 'burnaby': 'BC',
  'richmond': 'BC', 'kelowna': 'BC', 'victoria': 'BC', 'saskatoon': 'SK',
  'regina': 'SK', 'halifax': 'NS', 'moncton': 'NB', 'fredericton': 'NB',
  'st. john\'s': 'NL', 'thunder bay': 'ON', 'sudbury': 'ON',
  'kingston': 'ON', 'windsor': 'ON', 'barrie': 'ON', 'guelph': 'ON',
  'oshawa': 'ON', 'cambridge': 'ON', 'waterloo': 'ON',
};

function guessProvince(locationStr) {
  if (!locationStr) return null;
  const lower = locationStr.toLowerCase();
  for (const [key, abbr] of Object.entries(PROV_MAP)) {
    if (lower.includes(key)) return abbr;
  }
  return null;
}

function adzunaGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ConsTradeHire/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function scrapeCompanyJobs(companyName) {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_API_KEY;
  if (!appId || !appKey) return [];

  const url = `https://api.adzuna.com/v1/api/jobs/ca/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&company=${encodeURIComponent(companyName)}&where=Canada&content-type=application/json`;
  try {
    const data = await adzunaGet(url);
    return (data.results || []).map(j => ({
      title:       j.title         || '',
      description: j.description  || j.title || '',
      location:    j.location?.display_name || 'Canada',
      salary:      j.salary_min ? `$${Math.round(j.salary_min/1000)}k–$${Math.round((j.salary_max||j.salary_min)/1000)}k` : null,
      jobType:     j.contract_time || 'Full-time',
      externalUrl: j.redirect_url || null,
      externalId:  j.id ? String(j.id) : null,
      companyName,
      postedAt:    j.created ? new Date(j.created) : new Date(),
    })).filter(j => j.title && j.externalUrl);
  } catch (e) {
    console.warn(`[scrape] Adzuna failed for "${companyName}":`, e.message);
    return [];
  }
}

const router = express.Router();

// ─── ADMIN LOGIN (public — no auth required) ───
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      return res.status(503).json({ error: 'Admin access is not configured on this server.' });
    }
    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Find or create the admin user in DB for JWT payload
    let user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!user) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      user = await prisma.user.create({
        data: {
          name: 'Admin', email: ADMIN_EMAIL,
          passwordHash: hash, role: 'ADMIN',
          emailVerified: true,
          profile: { create: {} }
        }
      });
    }

    const token = generateToken(user);
    res.json({ token, name: user.name, email: user.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All other admin routes require ADMIN role
router.use(requireAuth, requireRole('ADMIN'));

// ─── STATS ────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, workers, employers, jobs, activeJobs, applications, messages] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'WORKER' } }),
      prisma.user.count({ where: { role: 'EMPLOYER' } }),
      prisma.job.count(),
      prisma.job.count({ where: { isActive: true } }),
      prisma.application.count(),
      prisma.message.count(),
    ]);
    res.json({ users, workers, employers, jobs, activeJobs, applications, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── USERS ────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { page = 1, search = '', role = '' } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;

    const where = {};
    if (search) where.OR = [
      { name:  { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
    if (role) where.role = role;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip, take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, email: true, role: true,
          emailVerified: true, isVerified: true, createdAt: true,
          _count: { select: { applications: true, postedJobs: true } }
        }
      }),
      prisma.user.count({ where })
    ]);

    res.json({ users, total, pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ban / unban — toggle emailVerified as a suspension flag
// We use a dedicated `banned` approach via emailVerified=false + a ban marker in name
// Simple approach: add [BANNED] prefix to name to block login in auth route
router.put('/users/:id/ban', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'ADMIN') return res.status(403).json({ error: 'Cannot ban an admin' });

    const isBanned = user.name.startsWith('[BANNED] ');
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { name: isBanned ? user.name.replace('[BANNED] ', '') : `[BANNED] ${user.name}` }
    });
    res.json({ banned: !isBanned, name: updated.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify / unverify employer (trust badge)
router.put('/users/:id/verify', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'EMPLOYER') return res.status(400).json({ error: 'Only employers can be verified' });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isVerified: !user.isVerified }
    });
    res.json({ isVerified: updated.isVerified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'ADMIN') return res.status(403).json({ error: 'Cannot delete an admin' });

    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── JOBS ─────────────────────────────────────
router.get('/jobs', async (req, res) => {
  try {
    const { page = 1, search = '' } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;

    const where = search
      ? { OR: [
          { title:    { contains: search, mode: 'insensitive' } },
          { location: { contains: search, mode: 'insensitive' } },
        ]}
      : {};

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where, skip, take,
        orderBy: { postedAt: 'desc' },
        select: {
          id: true, title: true, location: true, jobType: true,
          source: true, isActive: true, isFeatured: true, postedAt: true,
          companyName: true,
          employer: { select: { id: true, name: true, email: true } },
          _count: { select: { applications: true } }
        }
      }),
      prisma.job.count({ where })
    ]);

    res.json({ jobs, total, pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/jobs/:id/toggle', async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const updated = await prisma.job.update({
      where: { id: req.params.id },
      data: { isActive: !job.isActive }
    });
    res.json({ isActive: updated.isActive });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/jobs/:id', async (req, res) => {
  try {
    await prisma.job.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── JOB REPORTS ──────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const { page = 1, resolved = '' } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;
    const where = resolved === 'true' ? { resolved: true } : resolved === 'false' ? { resolved: false } : {};

    const [reports, total] = await Promise.all([
      prisma.jobReport.findMany({
        where, skip, take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } }
        }
      }),
      prisma.jobReport.count({ where })
    ]);
    res.json({ reports, total, pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/reports/:id/resolve', async (req, res) => {
  try {
    const updated = await prisma.jobReport.update({
      where: { id: req.params.id },
      data: { resolved: true }
    });
    res.json({ resolved: updated.resolved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── APPLICATIONS ─────────────────────────────
router.get('/applications', async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const take = 20;
    const skip = (Number(page) - 1) * take;

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        skip, take,
        orderBy: { appliedAt: 'desc' },
        select: {
          id: true, status: true, appliedAt: true,
          user: { select: { id: true, name: true, email: true } },
          job:  { select: { id: true, title: true, companyName: true } }
        }
      }),
      prisma.application.count()
    ]);

    res.json({ applications, total, pages: Math.ceil(total / take) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SCRAPE COMPANY JOBS ────────────────────────
// POST /api/admin/scrape-companies
// Pulls jobs from Adzuna for each company in our directory, saves new ones to DB
router.post('/scrape-companies', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const appId = process.env.ADZUNA_APP_ID;
  if (!appId) return res.status(503).json({ error: 'ADZUNA_APP_ID not configured' });

  const results = { added: 0, skipped: 0, errors: [], companies: [] };

  // Process companies sequentially to avoid rate-limiting Adzuna
  for (const company of SCRAPE_COMPANIES) {
    try {
      const jobs = await scrapeCompanyJobs(company);
      let added = 0;

      for (const j of jobs) {
        if (!j.externalUrl) continue;
        // Skip if already in DB
        const exists = await prisma.job.findFirst({ where: { externalUrl: j.externalUrl }, select: { id: true } });
        if (exists) { results.skipped++; continue; }

        const province = guessProvince(j.location);
        await prisma.job.create({
          data: {
            title:       j.title.trim(),
            description: j.description.trim(),
            location:    j.location,
            city:        j.location.split(',')[0]?.trim() || null,
            province,
            salary:      j.salary,
            jobType:     j.jobType,
            skills:      [],
            source:      'API',
            externalUrl: j.externalUrl,
            externalId:  j.externalId,
            companyName: j.companyName,
            postedAt:    j.postedAt,
            expiresAt:   new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
            isActive:    true,
          }
        });
        added++;
        results.added++;
      }

      results.companies.push({ company, found: jobs.length, added });

      // Small delay between companies to be polite to Adzuna
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      results.errors.push({ company, error: e.message });
    }
  }

  res.json({ ok: true, ...results });
});

module.exports = router;
