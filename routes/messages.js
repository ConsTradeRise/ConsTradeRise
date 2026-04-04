'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/messages/inbox — list all conversations (unique users)
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all messages involving this user
    const messages = await prisma.message.findMany({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      orderBy: { createdAt: 'desc' },
      include: {
        sender:   { select: { id: true, name: true, role: true } },
        receiver: { select: { id: true, name: true, role: true } }
      }
    });

    // Build conversation map — one entry per other user
    const convMap = new Map();
    for (const msg of messages) {
      const other = msg.senderId === userId ? msg.receiver : msg.sender;
      if (!convMap.has(other.id)) {
        convMap.set(other.id, {
          user:        other,
          lastMessage: msg.content,
          lastAt:      msg.createdAt,
          unread:      0
        });
      }
      if (!msg.read && msg.receiverId === userId) {
        convMap.get(other.id).unread++;
      }
    }

    res.json({ conversations: [...convMap.values()] });
  } catch (e) {
    console.error('[messages/inbox]', e.message);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

// GET /api/messages/unread-count
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await prisma.message.count({
      where: { receiverId: req.user.id, read: false }
    });
    res.json({ count });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// GET /api/messages/:userId — get conversation with a specific user
router.get('/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = req.params.userId;

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: me,    receiverId: other },
          { senderId: other, receiverId: me    }
        ]
      },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: { select: { id: true, name: true } }
      }
    });

    // Mark incoming messages as read
    await prisma.message.updateMany({
      where: { senderId: other, receiverId: me, read: false },
      data:  { read: true }
    });

    // Get other user info
    const otherUser = await prisma.user.findUnique({
      where:  { id: other },
      select: { id: true, name: true, role: true,
                profile: { select: { companyName: true, headline: true, city: true } } }
    });

    res.json({ messages, otherUser });
  } catch (e) {
    console.error('[messages/get]', e.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /api/messages/:userId — send a message
router.post('/:userId', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
    if (content.length > 2000) return res.status(400).json({ error: 'Message too long (max 2,000 characters)' });
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot message yourself' });

    // Verify receiver exists
    const receiver = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!receiver) return res.status(404).json({ error: 'User not found' });

    const message = await prisma.message.create({
      data: {
        senderId:   req.user.id,
        receiverId: req.params.userId,
        content:    content.trim()
      },
      include: { sender: { select: { id: true, name: true } } }
    });

    // Notify receiver
    await prisma.notification.create({
      data: {
        userId: req.params.userId,
        type:   'new_message',
        title:  'New Message',
        body:   `${req.user.name}: ${content.trim().substring(0, 80)}`,
        link:   `/messages.html?with=${req.user.id}`
      }
    });

    res.status(201).json({ message });
  } catch (e) {
    console.error('[messages/send]', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
