// ─────────────────────────────────────────────
//  ConsTradeHire — Jobs Routes
//  GET    /api/jobs          - list jobs (public)
//  GET    /api/jobs/:id      - job detail (public)
//  POST   /api/jobs          - employer post job
//  PUT    /api/jobs/:id      - employer update job
//  DELETE /api/jobs/:id      - employer delete job
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');
// Lazy-load to avoid circular dependency (server.js requires this file)
function getApp() { try { return require('../server'); } catch { return null; } }

const router = express.Router();
const prisma = new PrismaClient();

// Simple in-memory TTL cache for public jobs list (60s TTL)
const jobsCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds
function getCached(key) {
  const entry = jobsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { jobsCache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  if (jobsCache.size > 200) jobsCache.clear(); // prevent unbounded growth
  jobsCache.set(key, { data, ts: Date.now() });
}
// Invalidate cache on any write (post/update/delete)
function invalidateJobsCache() { jobsCache.clear(); }

// ─── LIST JOBS ────────────────────────────────
// GET /api/jobs?search=&location=&type=&page=
router.get('/', async (req, res) => {
  try {
    const cacheKey = JSON.stringify(req.query);
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const { search, location, type, province, sector, datePosted, sort } = req.query;
    const pageNum  = Math.max(1, parseInt(req.query.page)  || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Cap search string length to prevent ReDoS / oversized queries
    const safeSearch  = (search  || '').substring(0, 100);
    const safeLocation= (location|| '').substring(0, 100);
    const safeSector  = (sector  || '').substring(0, 100);

    // datePosted filter
    let postedAfter = null;
    if (datePosted === '24h')  postedAfter = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (datePosted === '7d')   postedAfter = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    if (datePosted === '30d')  postedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Build AND conditions — wrap each OR group in an AND so they don't overwrite each other
    const andConditions = [];
    if (safeSearch)   andConditions.push({ OR: [
      { title:       { contains: safeSearch, mode: 'insensitive' } },
      { description: { contains: safeSearch, mode: 'insensitive' } },
      { companyName: { contains: safeSearch, mode: 'insensitive' } },
      { skills:      { has: safeSearch } }
    ]});
    if (safeLocation) andConditions.push({ OR: [
      { city:     { contains: safeLocation, mode: 'insensitive' } },
      { province: { contains: safeLocation, mode: 'insensitive' } },
      { location: { contains: safeLocation, mode: 'insensitive' } }
    ]});
    if (safeSector)   andConditions.push({ OR: [
      { title:       { contains: safeSector, mode: 'insensitive' } },
      { description: { contains: safeSector, mode: 'insensitive' } },
      { skills:      { has: safeSector } }
    ]});

    const where = {
      isActive: true,
      ...(postedAfter && { postedAt: { gte: postedAfter } }),
      ...(province && { province: { contains: province.substring(0, 50), mode: 'insensitive' } }),
      ...(type && { jobType: type }),
      ...(andConditions.length && { AND: andConditions })
    };

    const orderBy = sort === 'newest'
      ? [{ postedAt: 'desc' }]
      : [{ isFeatured: 'desc' }, { postedAt: 'desc' }];

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take: limitNum,
        orderBy,
        select: {
          id: true,
          title: true,
          companyName: true,
          location: true,
          city: true,
          province: true,
          salary: true,
          jobType: true,
          skills: true,
          source: true,
          externalUrl: true,
          isFeatured: true,
          postedAt: true,
          employer: {
            select: { name: true, isVerified: true, profile: { select: { companyName: true } } }
          }
        }
      }),
      prisma.job.count({ where })
    ]);

    const result = {
      jobs,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    };
    setCached(cacheKey, result);
    res.json(result);

  } catch (e) {
    console.error('[jobs/list]', e.message);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ─── MY JOBS (employer) ───────────────────────
// GET /api/jobs/employer/mine
router.get('/employer/mine', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { employerId: req.user.id },
      orderBy: { postedAt: 'desc' },
      include: {
        _count: { select: { applications: true } }
      }
    });

    res.json({ jobs });

  } catch (e) {
    console.error('[jobs/mine]', e.message);
    res.status(500).json({ error: 'Failed to fetch your jobs' });
  }
});

// ─── JOB DETAIL ───────────────────────────────
// GET /api/jobs/:id
router.get('/:id', async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: {
        employer: {
          select: {
            id: true,
            name: true,
            profile: {
              select: { companyName: true, website: true, location: true }
            }
          }
        }
      }
    });

    if (!job || !job.isActive) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ job });

    // Increment view count fire-and-forget
    setImmediate(async () => {
      try {
        await prisma.job.update({ where: { id: req.params.id }, data: { viewCount: { increment: 1 } } });
      } catch (_) {}
    });

  } catch (e) {
    console.error('[jobs/detail]', e.message);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ─── POST JOB ─────────────────────────────────
// POST /api/jobs (employer only)
router.post('/', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const { title, description, location, city, province, salary, jobType, skills } = req.body;

    if (!title || !description || !location) {
      return res.status(400).json({ error: 'Title, description, and location are required' });
    }
    if (title.length > 200)       return res.status(400).json({ error: 'Title too long (max 200 chars)' });
    if (description.length > 10000) return res.status(400).json({ error: 'Description too long (max 10,000 chars)' });
    // Validate and sanitize skills array
    const cleanSkills = Array.isArray(skills)
      ? skills.filter(s => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 100)
              .map(s => s.trim())
              .slice(0, 30)
      : [];
    if (Array.isArray(skills) && skills.length > 30) return res.status(400).json({ error: 'Too many skills (max 30)' });

    // Get company name from employer profile
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: { companyName: true }
    });

    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days

    const job = await prisma.job.create({
      data: {
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        city: city?.trim(),
        province: province?.trim(),
        salary: salary?.trim(),
        jobType: jobType || 'Full-time',
        skills: cleanSkills,
        source: 'MANUAL',
        employerId: req.user.id,
        companyName: profile?.companyName || req.user.name,
        expiresAt
      }
    });

    invalidateJobsCache();
    res.status(201).json({ message: 'Job posted successfully', job });

    // Fire-and-forget: notify workers whose alerts match this job
    setImmediate(() => { try { getApp()?.triggerJobAlerts?.(job); } catch {} });

  } catch (e) {
    console.error('[jobs/post]', e.message);
    res.status(500).json({ error: 'Failed to post job' });
  }
});

// ─── UPDATE JOB ───────────────────────────────
// PUT /api/jobs/:id (employer only — their own jobs)
router.put('/:id', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });

    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Employers can only edit their own jobs
    if (req.user.role === 'EMPLOYER' && job.employerId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied — not your job' });
    }

    const { title, description, location, city, province, salary, jobType, skills, isActive, isFeatured } = req.body;

    const updated = await prisma.job.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title: title.trim() }),
        ...(description && { description: description.trim() }),
        ...(location && { location: location.trim() }),
        ...(city !== undefined && { city }),
        ...(province !== undefined && { province }),
        ...(salary !== undefined && { salary }),
        ...(jobType && { jobType }),
        ...(skills && { skills }),
        ...(isActive !== undefined && { isActive }),
        ...(isFeatured !== undefined && { isFeatured })
      }
    });

    invalidateJobsCache();
    res.json({ message: 'Job updated', job: updated });

  } catch (e) {
    console.error('[jobs/update]', e.message);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// ─── DELETE JOB ───────────────────────────────
// DELETE /api/jobs/:id (employer only — their own jobs)
router.delete('/:id', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });

    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Employers can only delete their own jobs
    if (req.user.role === 'EMPLOYER' && job.employerId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied — not your job' });
    }

    // Soft delete (set isActive = false)
    await prisma.job.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });

    invalidateJobsCache();
    res.json({ message: 'Job removed successfully' });

  } catch (e) {
    console.error('[jobs/delete]', e.message);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// ─── REPORT JOB ───────────────────────────────
// POST /api/jobs/:id/report (auth required)
router.post('/:id/report', requireAuth, async (req, res) => {
  try {
    const { reason, details } = req.body;
    const validReasons = ['scam', 'spam', 'inappropriate', 'duplicate', 'other'];
    if (!reason || !validReasons.includes(reason)) {
      return res.status(400).json({ error: 'Valid reason required: scam, spam, inappropriate, duplicate, other' });
    }

    const job = await prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    await prisma.jobReport.upsert({
      where: { jobId_userId: { jobId: req.params.id, userId: req.user.id } },
      create: {
        jobId: req.params.id,
        userId: req.user.id,
        reason,
        details: details?.substring(0, 500) || null
      },
      update: { reason, details: details?.substring(0, 500) || null }
    });

    res.json({ message: 'Report submitted. Thank you for keeping ConsTradeHire safe.' });
  } catch (e) {
    console.error('[jobs/report]', e.message);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

module.exports = router;
