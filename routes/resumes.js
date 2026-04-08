// ─────────────────────────────────────────────
//  ConsTradeHire — Resume Library Routes
//  Phase 2.4 + 2.5
//
//  GET    /api/resumes               - list user's resumes
//  GET    /api/resumes/:id           - get one resume + versions
//  POST   /api/resumes               - create resume (from text/AI content)
//  PUT    /api/resumes/:id           - rename / update content
//  DELETE /api/resumes/:id           - delete resume + versions
//  PUT    /api/resumes/:id/default   - set as default
//
//  GET    /api/resumes/:id/versions          - list versions
//  POST   /api/resumes/:id/versions          - save current content as new version
//  GET    /api/resumes/:id/versions/:vId     - get single version
//  DELETE /api/resumes/:id/versions/:vId     - delete version
//  POST   /api/resumes/:id/versions/:vId/restore - restore version to resume content
//
//  POST   /api/resumes/:id/tailor    - AI tailor resume to a job → auto-saves new version
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Shared ownership check
async function ownResume(userId, resumeId) {
  const r = await prisma.resume.findUnique({ where: { id: resumeId }, select: { userId: true } });
  return r && r.userId === userId ? r : null;
}

// ─── LIST RESUMES ─────────────────────────────
// GET /api/resumes
router.get('/', requireAuth, async (req, res) => {
  try {
    const resumes = await prisma.resume.findMany({
      where: { userId: req.user.id },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      include: {
        _count: { select: { versions: true, applications: true } }
      }
    });
    res.json({ resumes });
  } catch (e) {
    console.error('[resumes/list]', e.message);
    res.status(500).json({ error: 'Failed to fetch resumes' });
  }
});

// ─── GET ONE RESUME ───────────────────────────
// GET /api/resumes/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const resume = await prisma.resume.findUnique({
      where: { id: req.params.id },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 20 },
        _count: { select: { applications: true } }
      }
    });
    if (!resume || resume.userId !== req.user.id) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    res.json({ resume });
  } catch (e) {
    console.error('[resumes/get]', e.message);
    res.status(500).json({ error: 'Failed to fetch resume' });
  }
});

// ─── CREATE RESUME ────────────────────────────
// POST /api/resumes
// Body: { name, content, aiGenerated }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, content, aiGenerated } = req.body;
    if (!content || content.trim().length < 20) {
      return res.status(400).json({ error: 'Resume content is required (min 20 chars)' });
    }

    // If this is the first resume, make it default
    const count = await prisma.resume.count({ where: { userId: req.user.id } });

    const resume = await prisma.resume.create({
      data: {
        userId:      req.user.id,
        name:        (name || 'My Resume').substring(0, 100),
        content:     content.substring(0, 15000),
        isDefault:   count === 0,
        aiGenerated: !!aiGenerated
      }
    });

    res.status(201).json({ resume });
  } catch (e) {
    console.error('[resumes/create]', e.message);
    res.status(500).json({ error: 'Failed to create resume' });
  }
});

// ─── UPDATE RESUME ────────────────────────────
// PUT /api/resumes/:id
// Body: { name?, content? }
router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (!await ownResume(req.user.id, req.params.id)) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    const { name, content } = req.body;
    const data = {};
    if (name    !== undefined) data.name    = name.substring(0, 100);
    if (content !== undefined) data.content = content.substring(0, 15000);

    const resume = await prisma.resume.update({
      where: { id: req.params.id },
      data
    });
    res.json({ resume });
  } catch (e) {
    console.error('[resumes/update]', e.message);
    res.status(500).json({ error: 'Failed to update resume' });
  }
});

// ─── DELETE RESUME ────────────────────────────
// DELETE /api/resumes/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const resume = await prisma.resume.findUnique({
      where: { id: req.params.id },
      select: { userId: true, isDefault: true }
    });
    if (!resume || resume.userId !== req.user.id) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    await prisma.resume.delete({ where: { id: req.params.id } });

    // If deleted resume was default, promote the next most recent one
    if (resume.isDefault) {
      const next = await prisma.resume.findFirst({
        where: { userId: req.user.id },
        orderBy: { updatedAt: 'desc' }
      });
      if (next) {
        await prisma.resume.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[resumes/delete]', e.message);
    res.status(500).json({ error: 'Failed to delete resume' });
  }
});

// ─── SET DEFAULT ──────────────────────────────
// PUT /api/resumes/:id/default
router.put('/:id/default', requireAuth, async (req, res) => {
  try {
    if (!await ownResume(req.user.id, req.params.id)) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Clear existing default, then set new one (transaction)
    await prisma.$transaction([
      prisma.resume.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } }),
      prisma.resume.update({ where: { id: req.params.id }, data: { isDefault: true } })
    ]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[resumes/set-default]', e.message);
    res.status(500).json({ error: 'Failed to set default resume' });
  }
});

// ─── LIST VERSIONS ────────────────────────────
// GET /api/resumes/:id/versions
router.get('/:id/versions', requireAuth, async (req, res) => {
  try {
    if (!await ownResume(req.user.id, req.params.id)) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    const versions = await prisma.resumeVersion.findMany({
      where: { resumeId: req.params.id },
      orderBy: { version: 'desc' }
    });
    res.json({ versions });
  } catch (e) {
    console.error('[resumes/versions/list]', e.message);
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

// ─── SAVE NEW VERSION ─────────────────────────
// POST /api/resumes/:id/versions
// Body: { label?, content? }  — if content omitted, snapshots current resume.content
router.post('/:id/versions', requireAuth, async (req, res) => {
  try {
    const resume = await prisma.resume.findUnique({ where: { id: req.params.id } });
    if (!resume || resume.userId !== req.user.id) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    const content = req.body.content || resume.content;
    if (!content) return res.status(400).json({ error: 'No content to snapshot' });

    // Get next version number
    const last = await prisma.resumeVersion.findFirst({
      where: { resumeId: req.params.id },
      orderBy: { version: 'desc' },
      select: { version: true }
    });
    const nextVersion = (last?.version || 0) + 1;

    const version = await prisma.resumeVersion.create({
      data: {
        resumeId:    req.params.id,
        userId:      req.user.id,
        version:     nextVersion,
        label:       (req.body.label || `Version ${nextVersion}`).substring(0, 100),
        content:     content.substring(0, 15000),
        tailoredFor: req.body.tailoredFor || null,
        aiGenerated: !!req.body.aiGenerated
      }
    });

    res.status(201).json({ version });
  } catch (e) {
    console.error('[resumes/versions/create]', e.message);
    res.status(500).json({ error: 'Failed to save version' });
  }
});

// ─── GET SINGLE VERSION ───────────────────────
// GET /api/resumes/:id/versions/:vId
router.get('/:id/versions/:vId', requireAuth, async (req, res) => {
  try {
    const version = await prisma.resumeVersion.findUnique({ where: { id: req.params.vId } });
    if (!version || version.userId !== req.user.id || version.resumeId !== req.params.id) {
      return res.status(404).json({ error: 'Version not found' });
    }
    res.json({ version });
  } catch (e) {
    console.error('[resumes/versions/get]', e.message);
    res.status(500).json({ error: 'Failed to fetch version' });
  }
});

// ─── DELETE VERSION ───────────────────────────
// DELETE /api/resumes/:id/versions/:vId
router.delete('/:id/versions/:vId', requireAuth, async (req, res) => {
  try {
    const version = await prisma.resumeVersion.findUnique({ where: { id: req.params.vId } });
    if (!version || version.userId !== req.user.id || version.resumeId !== req.params.id) {
      return res.status(404).json({ error: 'Version not found' });
    }
    await prisma.resumeVersion.delete({ where: { id: req.params.vId } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[resumes/versions/delete]', e.message);
    res.status(500).json({ error: 'Failed to delete version' });
  }
});

// ─── RESTORE VERSION → RESUME ────────────────
// POST /api/resumes/:id/versions/:vId/restore
// Copies version.content back into resume.content and saves current as a new version first
router.post('/:id/versions/:vId/restore', requireAuth, async (req, res) => {
  try {
    const resume = await prisma.resume.findUnique({ where: { id: req.params.id } });
    if (!resume || resume.userId !== req.user.id) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    const version = await prisma.resumeVersion.findUnique({ where: { id: req.params.vId } });
    if (!version || version.resumeId !== req.params.id) {
      return res.status(404).json({ error: 'Version not found' });
    }

    // Snapshot current state before restoring
    const last = await prisma.resumeVersion.findFirst({
      where: { resumeId: req.params.id },
      orderBy: { version: 'desc' },
      select: { version: true }
    });
    const nextVersion = (last?.version || 0) + 1;

    await prisma.$transaction([
      // Snapshot current
      prisma.resumeVersion.create({
        data: {
          resumeId:    resume.id,
          userId:      resume.userId,
          version:     nextVersion,
          label:       `Before restore (v${version.version})`,
          content:     resume.content || '',
          aiGenerated: resume.aiGenerated
        }
      }),
      // Restore version content
      prisma.resume.update({
        where: { id: resume.id },
        data:  { content: version.content }
      })
    ]);

    res.json({ ok: true, restored: version.version });
  } catch (e) {
    console.error('[resumes/versions/restore]', e.message);
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

// ─── AI TAILOR RESUME TO JOB ─────────────────
// POST /api/resumes/:id/tailor
// Body: { jobId }
// Fetches job description, calls Claude to tailor resume, saves new version
router.post('/:id/tailor', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });

    const resume = await prisma.resume.findUnique({ where: { id: req.params.id } });
    if (!resume || resume.userId !== req.user.id) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (!resume.content) return res.status(400).json({ error: 'Resume has no content to tailor' });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, description: true, skills: true, companyName: true, location: true }
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Require AI client — lazy load from app-level
    let client;
    try {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('no key');
      const Anthropic = require('@anthropic-ai/sdk');
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch {
      return res.status(503).json({ error: 'AI tailoring requires ANTHROPIC_API_KEY in .env' });
    }

    const systemPrompt = `You are a professional Canadian resume writer specializing in construction and trades.
Your task is to tailor an existing resume to match a specific job posting.
Rules:
- Keep all facts accurate — do NOT fabricate experience, employers, or dates
- Reorder bullet points to front-load the most relevant experience
- Add job-relevant keywords naturally throughout the resume
- Strengthen weak bullet points using CAR format (Context, Action, Result) where possible
- Match the job's required skills in the Skills section
- Output the complete tailored resume in plain text, preserving the original structure`;

    const userPrompt = `JOB POSTING:
Title: ${job.title}
Company: ${job.companyName || 'Company'}
Location: ${job.location}
Required Skills: ${(job.skills || []).join(', ')}
Description:
${job.description.substring(0, 2000)}

ORIGINAL RESUME:
${resume.content.substring(0, 5000)}

Rewrite the resume to be optimally tailored for this job. Output the complete resume text only.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const tailoredContent = response.content?.[0]?.text || '';
    if (!tailoredContent || tailoredContent.length < 100) {
      return res.status(500).json({ error: 'AI returned empty response. Please try again.' });
    }

    // Save tailored version
    const last = await prisma.resumeVersion.findFirst({
      where: { resumeId: resume.id },
      orderBy: { version: 'desc' },
      select: { version: true }
    });
    const nextVersion = (last?.version || 0) + 1;

    const version = await prisma.resumeVersion.create({
      data: {
        resumeId:    resume.id,
        userId:      req.user.id,
        version:     nextVersion,
        label:       `Tailored for ${job.title}${job.companyName ? ` @ ${job.companyName}` : ''}`.substring(0, 100),
        content:     tailoredContent.substring(0, 15000),
        tailoredFor: jobId,
        aiGenerated: true
      }
    });

    res.json({
      version,
      tailoredContent,
      job: { id: job.id, title: job.title, company: job.companyName }
    });

  } catch (e) {
    console.error('[resumes/tailor]', e.message);
    res.status(500).json({ error: 'Tailoring failed: ' + e.message });
  }
});

module.exports = router;
