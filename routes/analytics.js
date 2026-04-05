'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma  = new PrismaClient();

// ─── EMPLOYER ANALYTICS ───────────────────────
// GET /api/analytics/employer
router.get('/employer', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { employerId: req.user.id },
      select: {
        id: true, title: true, viewCount: true, isActive: true, postedAt: true,
        _count: { select: { applications: true } },
        applications: {
          select: { status: true }
        }
      },
      orderBy: { postedAt: 'desc' }
    });

    // ATS score distribution for this employer's jobs
    const jobIds = jobs.map(j => j.id);
    const atsResults = jobIds.length ? await prisma.atsResult.findMany({
      where: { jobId: { in: jobIds } },
      select: { score: true }
    }) : [];

    const scoreBuckets = { excellent: 0, good: 0, fair: 0, poor: 0 };
    atsResults.forEach(r => {
      if (r.score >= 80)      scoreBuckets.excellent++;
      else if (r.score >= 60) scoreBuckets.good++;
      else if (r.score >= 40) scoreBuckets.fair++;
      else                    scoreBuckets.poor++;
    });

    const totalViews = jobs.reduce((s, j) => s + (j.viewCount || 0), 0);
    const totalApps  = jobs.reduce((s, j) => s + (j._count?.applications || 0), 0);
    const statusBreakdown = { APPLIED: 0, VIEWED: 0, SHORTLISTED: 0, REJECTED: 0 };
    jobs.forEach(j => j.applications.forEach(a => {
      if (statusBreakdown[a.status] !== undefined) statusBreakdown[a.status]++;
    }));

    res.json({
      summary: { totalJobs: jobs.length, totalViews, totalApps },
      jobs: jobs.map(j => ({
        id: j.id, title: j.title, isActive: j.isActive,
        views: j.viewCount || 0,
        applications: j._count?.applications || 0,
        conversionRate: j.viewCount > 0
          ? Math.round((j._count?.applications / j.viewCount) * 100)
          : 0
      })),
      statusBreakdown,
      atsDistribution: scoreBuckets
    });
  } catch (e) {
    console.error('[analytics/employer]', e.message);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ─── WORKER ANALYTICS ─────────────────────────
// GET /api/analytics/worker
router.get('/worker', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const [profile, apps, atsResults] = await Promise.all([
      prisma.profile.findUnique({
        where: { userId: req.user.id },
        select: { profileViews: true, skills: true }
      }),
      prisma.application.findMany({
        where: { userId: req.user.id },
        select: { status: true, appliedAt: true, jobId: true }
      }),
      prisma.atsResult.findMany({
        where: { userId: req.user.id },
        select: { score: true, matchStrength: true },
        orderBy: { createdAt: 'desc' },
        take: 20
      })
    ]);

    const statusBreakdown = { APPLIED: 0, VIEWED: 0, SHORTLISTED: 0, REJECTED: 0 };
    apps.forEach(a => { if (statusBreakdown[a.status] !== undefined) statusBreakdown[a.status]++; });

    const avgAts = atsResults.length
      ? Math.round(atsResults.reduce((s, r) => s + r.score, 0) / atsResults.length)
      : null;

    res.json({
      profileViews: profile?.profileViews || 0,
      totalApplications: apps.length,
      statusBreakdown,
      avgAtsScore: avgAts,
      recentAts: atsResults.slice(0, 5)
    });
  } catch (e) {
    console.error('[analytics/worker]', e.message);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
