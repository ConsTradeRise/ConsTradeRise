'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/notifications — get my notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take:    30
    });
    const unread = notifications.filter(n => !n.read).length;
    res.json({ notifications, unread });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// PUT /api/notifications/read-all — mark all as read
router.put('/read-all', requireAuth, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data:  { read: true }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// DELETE /api/notifications/:id — delete one
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.user.id }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

module.exports = router;
