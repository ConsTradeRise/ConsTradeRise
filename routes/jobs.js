// ─────────────────────────────────────────────
//  TradesUp — Jobs Routes
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

const router = express.Router();
const prisma = new PrismaClient();

// ─── LIST JOBS ────────────────────────────────
// GET /api/jobs?search=&location=&type=&page=
router.get('/', async (req, res) => {
  try {
    const { search, location, type, province, sector, datePosted, sort, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // datePosted filter
    let postedAfter = null;
    if (datePosted === '24h')  postedAfter = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (datePosted === '7d')   postedAfter = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    if (datePosted === '30d')  postedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const where = {
      isActive: true,
      ...(postedAfter && { postedAt: { gte: postedAfter } }),
      ...(search && {
        OR: [
          { title:       { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { companyName: { contains: search, mode: 'insensitive' } },
          { skills:      { has: search } }
        ]
      }),
      ...(location && {
        OR: [
          { city:     { contains: location, mode: 'insensitive' } },
          { province: { contains: location, mode: 'insensitive' } },
          { location: { contains: location, mode: 'insensitive' } }
        ]
      }),
      ...(province && { province: { contains: province, mode: 'insensitive' } }),
      ...(type && { jobType: type }),
      ...(sector && {
        OR: [
          { title:       { contains: sector, mode: 'insensitive' } },
          { description: { contains: sector, mode: 'insensitive' } },
          { skills:      { has: sector } }
        ]
      })
    };

    const orderBy = sort === 'newest'
      ? [{ postedAt: 'desc' }]
      : [{ isFeatured: 'desc' }, { postedAt: 'desc' }];

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take: parseInt(limit),
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
            select: { name: true, profile: { select: { companyName: true } } }
          }
        }
      }),
      prisma.job.count({ where })
    ]);

    res.json({
      jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (e) {
    console.error('[jobs/list]', e.message);
    res.status(500).json({ error: 'Failed to fetch jobs' });
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

    // Get company name from employer profile
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: { companyName: true }
    });

    const job = await prisma.job.create({
      data: {
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        city: city?.trim(),
        province: province?.trim(),
        salary: salary?.trim(),
        jobType: jobType || 'Full-time',
        skills: Array.isArray(skills) ? skills : [],
        source: 'MANUAL',
        employerId: req.user.id,
        companyName: profile?.companyName || req.user.name
      }
    });

    res.status(201).json({ message: 'Job posted successfully', job });

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

    const { title, description, location, city, province, salary, jobType, skills, isActive } = req.body;

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
        ...(isActive !== undefined && { isActive })
      }
    });

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

    res.json({ message: 'Job removed successfully' });

  } catch (e) {
    console.error('[jobs/delete]', e.message);
    res.status(500).json({ error: 'Failed to delete job' });
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

module.exports = router;
