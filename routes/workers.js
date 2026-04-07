'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma  = new PrismaClient();

// ─── BROWSE WORKERS (employer) ────────────────
// GET /api/workers
router.get('/', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const { search, province, skill, availability, jobId, page = 1 } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 10, 10);
    const skip = (Math.max(parseInt(page), 1) - 1) * limit;

    // If jobId provided, derive filters from the job posting
    let jobSkills = [];
    let jobProvince = province || null;
    let jobKeywords = search || null;
    if (jobId) {
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { skills: true, province: true, city: true, title: true, description: true }
      });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      // Only employer's own jobs
      if (req.user.role === 'EMPLOYER') {
        const owned = await prisma.job.count({ where: { id: jobId, employerId: req.user.id } });
        if (!owned) return res.status(403).json({ error: 'Access denied' });
      }
      jobSkills = job.skills || [];
      if (!jobProvince && job.province) jobProvince = job.province;
      if (!jobKeywords) jobKeywords = job.title;
    }

    const where = { visibleToEmployers: true, user: { role: 'WORKER' } };
    if (jobProvince) where.province = { equals: jobProvince, mode: 'insensitive' };
    if (availability) where.availability = { equals: availability, mode: 'insensitive' };
    if (skill) where.skills = { has: skill };

    const profiles = await prisma.profile.findMany({
      where,
      skip,
      take: limit * 5, // over-fetch for JS skill scoring
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { id: true, name: true, createdAt: true } } }
    });

    // Score and sort by skill overlap with job
    let filtered = profiles;
    if (jobSkills.length > 0) {
      const jobSkillsLc = jobSkills.map(s => s.toLowerCase());
      filtered = profiles
        .map(p => {
          const workerSkills = (p.skills || []).map(s => s.toLowerCase());
          const overlap = jobSkillsLc.filter(s => workerSkills.includes(s)).length;
          return { ...p, _score: overlap };
        })
        .filter(p => p._score > 0)
        .sort((a, b) => b._score - a._score);
    }

    // Keyword filter on top
    if (jobKeywords) {
      const q = jobKeywords.toLowerCase();
      const kwFiltered = filtered.filter(p =>
        p.headline?.toLowerCase().includes(q) ||
        p.skills?.some(s => s.toLowerCase().includes(q)) ||
        p.user?.name?.toLowerCase().includes(q)
      );
      if (kwFiltered.length > 0) filtered = kwFiltered;
    }

    filtered = filtered.slice(0, limit);

    // Increment profile views — bulk update, fire-and-forget
    if (filtered.length > 0) {
      setImmediate(async () => {
        try {
          await prisma.profile.updateMany({
            where: { id: { in: filtered.map(p => p.id) } },
            data:  { profileViews: { increment: 1 } }
          });
        } catch (_) {}
      });
    }

    // Strip private contact fields before sending to employer
    const safeWorkers = filtered.map(({ phone, email, linkedin, ...pub }) => pub);
    res.json({ workers: safeWorkers, total, page: Math.max(parseInt(page), 1) });
  } catch (e) {
    console.error('[workers/browse]', e.message);
    res.status(500).json({ error: 'Failed to fetch workers' });
  }
});

// ─── WORKER PUBLIC PROFILE ────────────────────
// GET /api/workers/:userId
router.get('/:userId', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.params.userId },
      include: { user: { select: { id: true, name: true, createdAt: true } } }
    });
    if (!profile || !profile.visibleToEmployers) {
      return res.status(404).json({ error: 'Profile not found or not visible' });
    }
    // Strip private contact fields from employer view
    const { phone, email, linkedin, ...publicProfile } = profile;
    // Increment view count (fire-and-forget)
    setImmediate(async () => {
      try {
        await prisma.profile.update({
          where: { id: profile.id },
          data:  { profileViews: { increment: 1 } }
        });
      } catch (_) {}
    });
    res.json({ profile: publicProfile });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
