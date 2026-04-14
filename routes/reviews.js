'use strict';
const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');

// POST /api/reviews — submit a review
// Workers can review employers, employers can review workers (after a completed application)
router.post('/', requireAuth, async (req, res) => {
  const { targetId, rating, comment } = req.body;
  const reviewerId = req.user.id;

  if (!targetId || !rating) {
    return res.status(400).json({ success: false, error: 'targetId and rating are required' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, error: 'rating must be 1-5' });
  }
  if (targetId === reviewerId) {
    return res.status(400).json({ success: false, error: 'Cannot review yourself' });
  }

  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ success: false, error: 'Target user not found' });

  const reviewer = await prisma.user.findUnique({ where: { id: reviewerId }, select: { role: true } });

  // Workers review employers, employers review workers
  const targetType = target.role === 'EMPLOYER' ? 'employer' : 'worker';
  if (reviewer.role === target.role) {
    return res.status(403).json({ success: false, error: 'Cannot review someone with the same role' });
  }

  // Verify a real interaction exists (application on a job posted by that employer)
  let hasInteraction = false;
  if (reviewer.role === 'WORKER' && target.role === 'EMPLOYER') {
    const app = await prisma.application.findFirst({
      where: { userId: reviewerId, job: { employerId: targetId } },
      select: { id: true }
    });
    hasInteraction = !!app;
  } else if (reviewer.role === 'EMPLOYER' && target.role === 'WORKER') {
    const app = await prisma.application.findFirst({
      where: { userId: targetId, job: { employerId: reviewerId } },
      select: { id: true }
    });
    hasInteraction = !!app;
  }

  if (!hasInteraction) {
    return res.status(403).json({ success: false, error: 'You can only review users you have interacted with' });
  }

  try {
    const review = await prisma.review.upsert({
      where: { reviewerId_targetId: { reviewerId, targetId } },
      update: { rating, comment: comment || null },
      create: { reviewerId, targetId, targetType, rating, comment: comment || null }
    });
    res.json({ success: true, data: review });
  } catch (err) {
    console.error('Review upsert error:', err);
    res.status(500).json({ success: false, error: 'Failed to save review' });
  }
});

// GET /api/reviews/:userId — get reviews for a user
router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  try {
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where: { targetId: userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          reviewer: {
            select: { id: true, name: true, role: true }
          }
        }
      }),
      prisma.review.count({ where: { targetId: userId } })
    ]);

    const avgRating = reviews.length
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null;

    res.json({
      success: true,
      data: reviews,
      meta: { total, page, limit, avgRating: avgRating ? +avgRating.toFixed(2) : null }
    });
  } catch (err) {
    console.error('Get reviews error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch reviews' });
  }
});

// GET /api/reviews/:userId/summary — rating summary (avg + breakdown)
router.get('/:userId/summary', async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      where: { targetId: req.params.userId },
      select: { rating: true }
    });

    const total = reviews.length;
    const avg = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviews.forEach(r => breakdown[r.rating]++);

    res.json({
      success: true,
      data: { total, avg: +avg.toFixed(2), breakdown }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch summary' });
  }
});

// DELETE /api/reviews/:targetId — remove own review of a user
router.delete('/:targetId', requireAuth, async (req, res) => {
  try {
    await prisma.review.delete({
      where: { reviewerId_targetId: { reviewerId: req.user.id, targetId: req.params.targetId } }
    });
    res.json({ success: true });
  } catch {
    res.status(404).json({ success: false, error: 'Review not found' });
  }
});

module.exports = router;
