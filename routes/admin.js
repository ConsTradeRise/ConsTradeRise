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
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// All admin routes require ADMIN role
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

module.exports = router;
