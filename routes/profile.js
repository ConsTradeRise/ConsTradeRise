// ─────────────────────────────────────────────
//  ConsTradeHire — Profile Routes
//  GET /api/profile/me
//  PUT /api/profile/me
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// ─── GET MY PROFILE ───────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id }
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({ profile });

  } catch (e) {
    console.error('[profile/me]', e.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── UPDATE MY PROFILE ────────────────────────
router.put('/me', requireAuth, async (req, res) => {
  try {
    const {
      // Contact
      phone, email, linkedin, city, province, country, location,
      // Identity
      headline, summary, yearsExperience, availability,
      openToRelocation, driversLicence,
      // Skills
      skills, skillCategories,
      // Structured
      experiences, educations, certifications,
      // Preferences
      visibleToEmployers, openToMatching, travelRadius,
      // Employer
      companyName, companySize, industry, website
    } = req.body;

    // Input length guards
    if (headline  && headline.length  > 200)  return res.status(400).json({ error: 'Headline too long (max 200)' });
    if (summary   && summary.length   > 3000) return res.status(400).json({ error: 'Summary too long (max 3,000)' });
    if (phone     && phone.length     > 20)   return res.status(400).json({ error: 'Invalid phone' });
    if (linkedin  && linkedin.length  > 200)  return res.status(400).json({ error: 'LinkedIn URL too long' });
    if (Array.isArray(skills) && skills.length > 50) return res.status(400).json({ error: 'Too many skills (max 50)' });
    if (Array.isArray(experiences)    && experiences.length    > 20) return res.status(400).json({ error: 'Too many experience entries' });
    if (Array.isArray(educations)     && educations.length     > 10) return res.status(400).json({ error: 'Too many education entries' });
    if (Array.isArray(certifications) && certifications.length > 20) return res.status(400).json({ error: 'Too many certification entries' });

    const data = {
      ...(phone       !== undefined && { phone }),
      ...(email       !== undefined && { email }),
      ...(linkedin    !== undefined && { linkedin }),
      ...(city        !== undefined && { city }),
      ...(province    !== undefined && { province }),
      ...(country     !== undefined && { country }),
      ...(location    !== undefined && { location }),
      ...(headline    !== undefined && { headline }),
      ...(summary     !== undefined && { summary }),
      ...(yearsExperience !== undefined && { yearsExperience: parseInt(yearsExperience) || null }),
      ...(availability    !== undefined && { availability }),
      ...(openToRelocation !== undefined && { openToRelocation: Boolean(openToRelocation) }),
      ...(driversLicence  !== undefined && { driversLicence }),
      ...(skills          !== undefined && { skills: Array.isArray(skills) ? skills : [] }),
      ...(skillCategories !== undefined && { skillCategories }),
      ...(experiences     !== undefined && { experiences }),
      ...(educations      !== undefined && { educations }),
      ...(certifications  !== undefined && { certifications }),
      ...(visibleToEmployers !== undefined && { visibleToEmployers }),
      ...(openToMatching     !== undefined && { openToMatching }),
      ...(travelRadius    !== undefined && { travelRadius: parseInt(travelRadius) || null }),
      ...(companyName  !== undefined && { companyName }),
      ...(companySize  !== undefined && { companySize }),
      ...(industry     !== undefined && { industry }),
      ...(website      !== undefined && { website })
    };

    const profile = await prisma.profile.upsert({
      where: { userId: req.user.id },
      update: data,
      create: { userId: req.user.id, skills: [], visibleToEmployers: true, openToMatching: true, ...data }
    });

    res.json({ message: 'Profile updated', profile });

  } catch (e) {
    console.error('[profile/update]', e.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── GET PUBLIC PROFILE (employer views candidate) ───
// Returns limited data based on visibility settings
router.get('/:userId', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.params.userId },
      include: {
        user: { select: { id: true, name: true, role: true } }
      }
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Workers can only view their own profile; employers can view workers (if visible); admins see all
    if (req.user.role === 'WORKER' && profile.user.id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (req.user.role === 'EMPLOYER') {
      if (!profile.visibleToEmployers) {
        return res.status(403).json({ error: 'This candidate has restricted their profile visibility' });
      }
      // Strip phone from employer view
      const { phone, email: _e, ...publicProfile } = profile;
      return res.json({ profile: publicProfile });
    }

    res.json({ profile });

  } catch (e) {
    console.error('[profile/public]', e.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── RESUME VERSIONS ─────────────────────────
router.get('/resumes', requireAuth, async (req, res) => {
  try {
    const resumes = await prisma.resume.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, createdAt: true }
    });
    res.json({ resumes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/resumes/:id', requireAuth, async (req, res) => {
  try {
    const resume = await prisma.resume.findUnique({ where: { id: req.params.id } });
    if (!resume || resume.userId !== req.user.id)
      return res.status(404).json({ error: 'Resume not found' });
    await prisma.resume.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
