// ─────────────────────────────────────────────
//  ConsTradeHire — AI Agent Routes
//  POST /api/ai/match         Worker job matching (Match Profile to Positions)
//  POST /api/ai/generate-job  Employer job description generator (Job Posting Generator)
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const prisma   = require('../utils/prisma');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function getAI() {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) return null;
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch { return null; }
}

// ─── MATCH PROFILE TO POSITIONS ──────────────
// POST /api/ai/match
// Returns AI-scored job matches for the logged-in worker
router.post('/match', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: {
        skills: true, headline: true, city: true,
        province: true, yearsExperience: true, summary: true
      }
    });

    if (!profile) return res.status(404).json({ error: 'Profile not found. Complete your profile first.' });

    // Pull recent active jobs — filter by province when available
    const where = { isActive: true };
    if (profile.province) where.province = profile.province;

    const jobs = await prisma.job.findMany({
      where,
      take: 20,
      orderBy: { postedAt: 'desc' },
      select: {
        id: true, title: true, location: true, city: true, province: true,
        jobType: true, skills: true, salary: true, companyName: true,
        isFeatured: true, postedAt: true
      }
    });

    if (!jobs.length) return res.json({ jobs: [], aiPowered: false });

    const ai = getAI();

    // Fallback: rank by skill overlap when AI is unavailable
    if (!ai) {
      const workerSkills = (profile.skills || []).map(s => s.toLowerCase());
      const scored = jobs.map(j => {
        const overlap = (j.skills || []).filter(s => workerSkills.includes(s.toLowerCase())).length;
        const headlineMatch = profile.headline && j.title.toLowerCase().includes(profile.headline.split(' ')[0].toLowerCase()) ? 15 : 0;
        return { ...j, score: Math.min(95, overlap * 18 + headlineMatch + 40), reason: 'Based on your skills' };
      }).sort((a, b) => b.score - a.score).slice(0, 5);
      return res.json({ jobs: scored, aiPowered: false });
    }

    // Build concise profile summary for Claude
    const profileLines = [
      profile.headline   && `Role: ${profile.headline}`,
      profile.skills?.length && `Skills: ${profile.skills.slice(0, 10).join(', ')}`,
      profile.city       && `Location: ${profile.city}${profile.province ? ', ' + profile.province : ''}`,
      profile.yearsExperience && `Experience: ${profile.yearsExperience} years`,
      profile.summary    && `Summary: ${profile.summary.slice(0, 200)}`
    ].filter(Boolean).join('\n');

    const jobLines = jobs.map((j, i) =>
      `[${i}] ${j.title} @ ${j.companyName || 'Company'} | ${j.city || j.location || 'Ontario'} | ${j.jobType || 'Full-time'} | Skills: ${(j.skills || []).slice(0, 6).join(', ') || 'N/A'}`
    ).join('\n');

    const msg = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a construction trades job matching engine for Canada. Score each job (0-100) for this worker.

WORKER:
${profileLines}

JOBS:
${jobLines}

Return ONLY a valid JSON array with exactly 5 entries (highest scores), sorted descending. No markdown, no explanation.
Format: [{"index":0,"score":87,"reason":"Strong fit for your carpentry and framing experience"}]`
      }]
    });

    let scored;
    try {
      const text = msg.content[0].text.trim().replace(/```json|```/g, '');
      const parsed = JSON.parse(text);
      scored = parsed
        .slice(0, 5)
        .filter(item => item.index >= 0 && item.index < jobs.length)
        .map(item => ({ ...jobs[item.index], score: item.score, reason: item.reason }));
      // Ensure we always return something
      if (!scored.length) throw new Error('empty');
    } catch {
      scored = jobs.slice(0, 5).map(j => ({ ...j, score: 72, reason: 'Recommended for you' }));
    }

    res.json({ jobs: scored, aiPowered: true });
  } catch (e) {
    console.error('[ai/match]', e.message);
    res.status(500).json({ error: 'Matching unavailable. Please try again.' });
  }
});

// ─── JOB POSTING GENERATOR ───────────────────
// POST /api/ai/generate-job
// Generates a professional job description for employers
router.post('/generate-job', requireAuth, requireRole('EMPLOYER'), async (req, res) => {
  try {
    const ai = getAI();
    if (!ai) return res.status(503).json({ error: 'AI not configured. Please contact support.' });

    const { title, city, province, jobType, salary } = req.body;
    if (!title) return res.status(400).json({ error: 'Job title is required.' });

    const context = [
      `Job Title: ${title}`,
      city     && `Location: ${city}${province ? ', ' + province : ', Ontario'}`,
      jobType  && `Employment Type: ${jobType}`,
      salary   && `Compensation: ${salary}`
    ].filter(Boolean).join('\n');

    const msg = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 650,
      messages: [{
        role: 'user',
        content: `Write a clear, practical job posting for a Canadian construction/trades employer. Be direct and specific. No marketing fluff.

${context}

Use these four sections with plain text (no markdown symbols like ** or ##):

ABOUT THE ROLE
2-3 sentences describing the position and team.

KEY RESPONSIBILITIES
- Specific duty
- Specific duty
- Specific duty
- Specific duty

REQUIREMENTS
- Qualification or certification
- Years of experience
- Specific skill
- Any other requirement

WHAT WE OFFER
- Compensation detail
- Work environment or schedule benefit
- Any other perk

Keep it under 300 words total. Make it sound like a real Canadian trades employer.`
      }]
    });

    res.json({ description: msg.content[0].text.trim() });
  } catch (e) {
    console.error('[ai/generate-job]', e.message);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

module.exports = router;
