// ─────────────────────────────────────────────
//  ConsTradeHire — Cover Letter Generator
//  POST /api/cover-letter/generate
//  Template-based (free). Uses Claude if key set.
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth, requireRole } = require('../middleware/auth');

const router  = express.Router();

function templateCoverLetter(profile, job, user) {
  const fullName  = user.name || '';
  const headline  = (profile.headline || '').split('|')[0].trim() || 'construction professional';
  const city      = profile.city || 'Ontario';
  const province  = profile.province || '';
  const location  = [city, province].filter(Boolean).join(', ');
  const years     = profile.yearsExperience ? `${profile.yearsExperience}+ years of` : 'extensive';
  const topSkills = (profile.skills || []).slice(0, 4).join(', ');
  const summary   = profile.summary || '';
  const avail     = profile.availability ? profile.availability.toLowerCase() : 'available';
  const company   = job.companyName || 'your organization';
  const jobTitle  = job.title;

  const expLine = (() => {
    const exps = Array.isArray(profile.experiences) ? profile.experiences : [];
    if (!exps.length) return '';
    const latest = exps[0];
    return `In my most recent role as ${latest.title || headline} at ${latest.company || 'a construction firm'}, I ${latest.bullets ? latest.bullets.split('\n')[0].toLowerCase().replace(/^[•\-\s]+/, '') : 'delivered results on complex construction projects'}.`;
  })();

  return `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle} position at ${company}. With ${years} experience as a ${headline}, I am confident I can make a meaningful contribution to your team.

${topSkills ? `My technical expertise includes ${topSkills} — skills that align directly with the requirements of this role.` : ''}

${summary || `I have a proven track record in the construction industry, consistently delivering projects on time, within budget, and to the highest quality standards.`}

${expLine}

I am based in ${location} and ${avail === 'immediate' ? 'am available to start immediately' : `am ${avail} for new opportunities`}. I would welcome the chance to discuss how my background aligns with your needs.

Thank you for your time and consideration. I look forward to hearing from you.

Sincerely,
${fullName}${profile.phone ? '\n' + profile.phone : ''}${profile.email ? '\n' + profile.email : ''}${profile.linkedin ? '\n' + profile.linkedin : ''}`.trim();
}

// POST /api/cover-letter/generate
router.post('/generate', requireAuth, requireRole('WORKER'), async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });

    const [profile, job, user] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: req.user.id } }),
      prisma.job.findUnique({ where: { id: jobId }, select: { title: true, description: true, companyName: true, skills: true } }),
      prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } })
    ]);

    if (!job)     return res.status(404).json({ error: 'Job not found' });
    if (!profile) return res.status(404).json({ error: 'Please complete your profile first' });

    // Try Claude if key is set
    const Anthropic = (() => { try { return require('@anthropic-ai/sdk'); } catch { return null; } })();
    if (Anthropic && process.env.ANTHROPIC_API_KEY) {
      try {
        const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const prompt = `Write a professional cover letter for a ${job.title} position at ${job.companyName || 'a company'}.

Applicant profile:
- Name: ${user.name}
- Headline: ${profile.headline || ''}
- Location: ${profile.city || ''}, ${profile.province || ''}
- Years experience: ${profile.yearsExperience || 'N/A'}
- Skills: ${(profile.skills || []).join(', ')}
- Summary: ${profile.summary || ''}

Job description excerpt: ${job.description.slice(0, 600)}

Write a concise, professional cover letter (3–4 paragraphs). Address it to "Dear Hiring Manager". Sign with the applicant's name. Do not invent specific project names or companies not mentioned. Keep it under 300 words.`;

        const msg = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }]
        });
        const text = msg.content[0]?.text?.trim();
        if (text) return res.json({ coverLetter: text, source: 'ai' });
      } catch (_) { /* fall through to template */ }
    }

    res.json({ coverLetter: templateCoverLetter(profile, job, user), source: 'template' });

  } catch (e) {
    console.error('[cover-letter/generate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
