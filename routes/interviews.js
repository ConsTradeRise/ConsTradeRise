'use strict';
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── PROPOSE INTERVIEW (employer) ─────────────
// POST /api/interviews
router.post('/', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const { applicationId, proposedDates, location, notes } = req.body;
    if (!applicationId || !proposedDates?.length) {
      return res.status(400).json({ error: 'applicationId and at least one proposedDate are required' });
    }

    // Validate proposed dates — must be valid future ISO datetime strings (max 10)
    const now = new Date();
    const validDates = (Array.isArray(proposedDates) ? proposedDates : [])
      .filter(d => {
        if (typeof d !== 'string') return false;
        const dt = new Date(d);
        return !isNaN(dt.getTime()) && dt > now;
      })
      .slice(0, 10);
    if (!validDates.length) {
      return res.status(400).json({ error: 'At least one valid future date is required' });
    }

    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { job: true }
    });
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (req.user.role === 'EMPLOYER' && app.job.employerId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const interview = await prisma.interview.upsert({
      where:  { applicationId },
      update: { proposedDates: validDates, location: location?.substring(0, 200) || null,
                notes: notes?.substring(0, 1000) || null, status: 'PENDING', acceptedDate: null },
      create: { applicationId, employerId: req.user.id, workerId: app.userId,
                proposedDates: validDates, location: location?.substring(0, 200) || null,
                notes: notes?.substring(0, 1000) || null }
    });

    // Notify worker
    await prisma.notification.create({
      data: {
        userId: app.userId,
        type:  'interview_invite',
        title: 'Interview Invitation',
        body:  `You've been invited to interview for "${app.job.title}"`,
        link:  '/dashboard.html#applications'
      }
    });

    res.status(201).json({ interview });
  } catch (e) {
    console.error('[interviews/propose]', e.message);
    res.status(500).json({ error: 'Failed to create interview' });
  }
});

// ─── WORKER RESPONDS ──────────────────────────
// PUT /api/interviews/:id/respond
router.put('/:id/respond', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const { status, acceptedDate } = req.body;
    if (!['ACCEPTED', 'DECLINED'].includes(status)) {
      return res.status(400).json({ error: 'status must be ACCEPTED or DECLINED' });
    }

    const interview = await prisma.interview.findUnique({ where: { id: req.params.id } });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (interview.workerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (status === 'ACCEPTED' && !acceptedDate) {
      return res.status(400).json({ error: 'acceptedDate required when accepting' });
    }

    const updated = await prisma.interview.update({
      where: { id: req.params.id },
      data:  { status, acceptedDate: acceptedDate || null }
    });

    // Notify employer
    const app = await prisma.application.findUnique({
      where: { id: interview.applicationId },
      include: { job: true, user: { select: { name: true } } }
    });
    await prisma.notification.create({
      data: {
        userId: interview.employerId,
        type:  'interview_response',
        title: `Interview ${status === 'ACCEPTED' ? 'Accepted' : 'Declined'}`,
        body:  `${app?.user?.name || 'Candidate'} ${status === 'ACCEPTED' ? 'accepted' : 'declined'} the interview for "${app?.job?.title}"`,
        link:  `/employer.html`
      }
    });

    res.json({ interview: updated });
  } catch (e) {
    console.error('[interviews/respond]', e.message);
    res.status(500).json({ error: 'Failed to respond to interview' });
  }
});

// ─── GET WORKER'S INTERVIEWS ──────────────────
// GET /api/interviews/mine
router.get('/mine', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const interviews = await prisma.interview.findMany({
      where: { workerId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        application: {
          include: {
            job: { select: { id: true, title: true, companyName: true } }
          }
        }
      }
    });
    res.json({ interviews });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ─── GET INTERVIEW FOR APPLICATION (employer) ──
// GET /api/interviews/application/:appId
router.get('/application/:appId', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    // Ownership check — employer can only view interviews for their own jobs
    if (req.user.role === 'EMPLOYER') {
      const app = await prisma.application.findUnique({
        where: { id: req.params.appId },
        include: { job: { select: { employerId: true } } }
      });
      if (!app) return res.status(404).json({ error: 'Application not found' });
      if (app.job.employerId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const interview = await prisma.interview.findUnique({
      where: { applicationId: req.params.appId }
    });
    res.json({ interview: interview || null });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ─── CANCEL INTERVIEW (employer) ──────────────
// DELETE /api/interviews/:id
router.delete('/:id', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const interview = await prisma.interview.findUnique({ where: { id: req.params.id } });
    if (!interview) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'EMPLOYER' && interview.employerId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await prisma.interview.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
    res.json({ message: 'Interview cancelled' });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
