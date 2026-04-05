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
    const { search, province, skill, availability, page = 1 } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // cap at 50
    const skip = (Math.max(parseInt(page), 1) - 1) * limit;

    // Build Prisma where on Profile
    const where = {
      visibleToEmployers: true,
      user: { role: 'WORKER' }
    };
    if (province)     where.province    = { equals: province, mode: 'insensitive' };
    if (availability) where.availability = { equals: availability, mode: 'insensitive' };
    if (skill)        where.skills       = { has: skill };

    const [profiles, total] = await Promise.all([
      prisma.profile.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { updatedAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, createdAt: true } }
        }
      }),
      prisma.profile.count({ where })
    ]);

    // Text search filter (headline / skills) — done in JS since Postgres array search is limited
    let filtered = profiles;
    if (search) {
      const q = search.toLowerCase();
      filtered = profiles.filter(p =>
        p.headline?.toLowerCase().includes(q) ||
        p.summary?.toLowerCase().includes(q) ||
        p.skills?.some(s => s.toLowerCase().includes(q)) ||
        p.user?.name?.toLowerCase().includes(q)
      );
    }

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
