// ─────────────────────────────────────────────
//  ConsTradeHire — Job Alerts
//  GET    /api/alerts        — list my alerts
//  POST   /api/alerts        — create alert
//  PUT    /api/alerts/:id    — toggle active
//  DELETE /api/alerts/:id    — delete alert
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma  = new PrismaClient();

// All alert routes require a logged-in WORKER
router.use(requireAuth, requireRole('WORKER'));

// GET /api/alerts
router.get('/', async (req, res) => {
  try {
    const alerts = await prisma.jobAlert.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ alerts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/alerts  { keywords, province, jobType }
router.post('/', async (req, res) => {
  try {
    const { keywords = '', province = '', jobType = '' } = req.body;
    const kw = keywords.trim().substring(0, 200);
    if (!kw) return res.status(400).json({ error: 'keywords required' });

    // Max 10 alerts per user
    const count = await prisma.jobAlert.count({ where: { userId: req.user.id } });
    if (count >= 10) return res.status(400).json({ error: 'Maximum 10 alerts allowed' });

    const alert = await prisma.jobAlert.create({
      data: {
        userId:   req.user.id,
        keywords: kw,
        province: province.trim() || null,
        jobType:  jobType.trim()  || null,
        active:   true
      }
    });
    res.status(201).json({ alert });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/alerts/:id  — toggle active
router.put('/:id', async (req, res) => {
  try {
    const alert = await prisma.jobAlert.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const updated = await prisma.jobAlert.update({
      where: { id: req.params.id },
      data:  { active: !alert.active }
    });
    res.json({ alert: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/alerts/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.jobAlert.deleteMany({
      where: { id: req.params.id, userId: req.user.id }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
