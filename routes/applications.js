// ─────────────────────────────────────────────
//  ConsTradeHire — Applications Routes
//  POST /api/applications           - worker applies
//  GET  /api/applications/mine      - worker: my applications
//  GET  /api/applications/job/:id   - employer: applicants for their job
//  PUT  /api/applications/:id/status - employer: update status
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendNewApplicationAlert, sendApplicationUpdate } = require('../utils/email');

const router = express.Router();
const prisma = new PrismaClient();

// ─── APPLY ────────────────────────────────────
// POST /api/applications
router.post('/', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const { jobId, resumeId, coverLetter } = req.body;

    if (!jobId) return res.status(400).json({ error: 'jobId is required' });

    // Check job exists and is active
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job || !job.isActive) {
      return res.status(404).json({ error: 'Job not found or no longer active' });
    }

    // Check resume belongs to user if provided
    if (resumeId) {
      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== req.user.id) {
        return res.status(400).json({ error: 'Invalid resume' });
      }
    }

    // Prevent duplicate applications (unique constraint on userId+jobId)
    const application = await prisma.application.create({
      data: {
        userId: req.user.id,
        jobId,
        resumeId: resumeId || null,
        coverLetter: coverLetter || null
      }
    });

    // Notify employer (in-app + email)
    if (job.employerId) {
      const employer = await prisma.user.findUnique({
        where: { id: job.employerId }, select: { email: true, name: true }
      });
      await prisma.notification.create({
        data: {
          userId: job.employerId,
          type: 'new_application',
          title: 'New Application',
          body: `${req.user.name} applied for "${job.title}"`,
          link: `/employer/jobs/${jobId}/applicants`
        }
      });
      if (employer) {
        sendNewApplicationAlert({
          to:           employer.email,
          employerName: employer.name,
          workerName:   req.user.name,
          jobTitle:     job.title
        }).catch(() => {});
      }
    }

    res.status(201).json({ message: 'Application submitted', application });

  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'You have already applied for this job' });
    }
    console.error('[applications/apply]', e.message);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// ─── MY APPLICATIONS (worker) ─────────────────
// GET /api/applications/mine
router.get('/mine', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const applications = await prisma.application.findMany({
      where: { userId: req.user.id },
      orderBy: { appliedAt: 'desc' },
      include: {
        job: {
          select: {
            id: true, title: true, companyName: true,
            location: true, jobType: true, isActive: true
          }
        },
        resume: { select: { id: true, name: true } }
      }
    });

    // Attach ATS score for each job
    const jobIds = applications.map(a => a.jobId);
    const atsResults = await prisma.atsResult.findMany({
      where: { userId: req.user.id, jobId: { in: jobIds } },
      select: { jobId: true, score: true, matchStrength: true }
    });
    const atsMap = {};
    atsResults.forEach(r => { atsMap[r.jobId] = r.score; });

    const enriched = applications.map(a => ({ ...a, atsScore: atsMap[a.jobId] ?? null }));

    res.json({ applications: enriched });

  } catch (e) {
    console.error('[applications/mine]', e.message);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// ─── JOB APPLICANTS (employer) ───────────────
// GET /api/applications/job/:jobId
router.get('/job/:jobId', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    // Verify employer owns this job
    const job = await prisma.job.findUnique({ where: { id: req.params.jobId } });

    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (req.user.role === 'EMPLOYER' && job.employerId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied — not your job' });
    }

    const applications = await prisma.application.findMany({
      where: { jobId: req.params.jobId },
      orderBy: { appliedAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            profile: {
              select: {
                city: true, province: true, skills: true,
                yearsExperience: true, visibleToEmployers: true
              }
            }
          }
        },
        resume: { select: { id: true, name: true } },
        // Include ATS score if available
        job: {
          include: {
            atsResults: {
              where: { userId: { in: [] } }, // populated dynamically
              select: { userId: true, score: true, matchStrength: true }
            }
          }
        }
      }
    });

    // Attach ATS scores to each applicant
    const userIds = applications.map(a => a.userId);
    const atsResults = await prisma.atsResult.findMany({
      where: { jobId: req.params.jobId, userId: { in: userIds } },
      select: { userId: true, score: true, matchStrength: true }
    });

    const atsMap = {};
    atsResults.forEach(r => { atsMap[r.userId] = r; });

    const enriched = applications.map(app => ({
      ...app,
      atsScore: atsMap[app.userId] || null
    }));

    // Sort by ATS score descending (ranked candidates)
    enriched.sort((a, b) => {
      const scoreA = a.atsScore?.score || 0;
      const scoreB = b.atsScore?.score || 0;
      return scoreB - scoreA;
    });

    res.json({ applications: enriched, total: enriched.length });

  } catch (e) {
    console.error('[applications/job]', e.message);
    res.status(500).json({ error: 'Failed to fetch applicants' });
  }
});

// ─── UPDATE STATUS (employer) ─────────────────
// PUT /api/applications/:id/status
router.put('/:id/status', requireAuth, requireRole('EMPLOYER', 'ADMIN'), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['APPLIED', 'VIEWED', 'SHORTLISTED', 'REJECTED'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }

    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { job: true, user: { select: { email: true, name: true } } }
    });

    if (!application) return res.status(404).json({ error: 'Application not found' });

    // Verify employer owns this job
    if (req.user.role === 'EMPLOYER' && application.job.employerId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updated = await prisma.application.update({
      where: { id: req.params.id },
      data: { status }
    });

    // Notify worker (in-app + email)
    await prisma.notification.create({
      data: {
        userId: application.userId,
        type: 'application_update',
        title: 'Application Update',
        body: `Your application for "${application.job.title}" has been ${status.toLowerCase()}`,
        link: `/dashboard/applications`
      }
    });

    if (status !== 'APPLIED') {
      sendApplicationUpdate({
        to:         application.user.email,
        workerName: application.user.name,
        jobTitle:   application.job.title,
        company:    application.job.companyName || 'the employer',
        status
      }).catch(() => {});
    }

    res.json({ message: 'Status updated', application: updated });

  } catch (e) {
    console.error('[applications/status]', e.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;
