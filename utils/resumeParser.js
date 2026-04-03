'use strict';

// ============================================================
//  Rule-based Resume Parser — no AI, no API credits
//  Works by regex + section detection + keyword matching
// ============================================================

const SKILL_CATEGORIES = {
  'Estimating': [
    'estimating', 'cost estimation', 'quantity takeoff', 'material takeoff',
    'bid preparation', 'tender', 'bluebeam', 'on-screen takeoff', 'planswift',
    'sage estimating', 'hard bid', 'unit pricing', 'cost analysis',
    'budget preparation', 'value engineering', 'cost control', 'quantity surveying'
  ],
  'Project Coordination': [
    'project management', 'project coordination', 'scheduling', 'gantt',
    'ms project', 'rfi', 'request for information', 'submittals', 'change orders',
    'change management', 'procurement', 'subcontractor management', 'site supervision',
    'quality control', 'progress reporting', 'milestone tracking', 'contract administration',
    'document control', 'site inspection', 'commissioning'
  ],
  'Technical Tools': [
    'autocad', 'revit', 'bim', 'building information modeling', 'sketchup', 'procore',
    'primavera', 'p6', 'buildertrend', 'ms office', 'microsoft excel', 'excel',
    'sage 300', 'jonas software', 'viewpoint', 'bluebeam revu', 'stack',
    'on center', 'stack cad', 'teams', 'sharepoint', 'aconex'
  ],
  'Sectors': [
    'residential', 'commercial', 'industrial', 'civil', 'infrastructure', 'ici',
    'low-rise', 'high-rise', 'multi-residential', 'renovation', 'retrofit', 'fit-out',
    'institutional', 'healthcare', 'education', 'municipal', 'road construction',
    'bridge', 'utilities', 'underground', 'mechanical', 'electrical'
  ],
  'Compliance': [
    'ohsa', 'health and safety', 'building code', 'ontario building code', 'obc',
    'iso 9001', 'leed', 'whmis', 'fall protection', 'confined space', 'first aid',
    'environmental compliance', 'green building', 'sustainable construction', 'csa'
  ]
};

const SECTION_PATTERNS = {
  experience:      /^(work\s+experience|professional\s+experience|employment(\s+history)?|experience|career\s+history|relevant\s+experience)\s*:?\s*$/i,
  education:       /^(education(\s+&\s+training)?|academic\s+(background|qualifications?)|qualifications?|schooling)\s*:?\s*$/i,
  skills:          /^(skills|technical\s+skills|core\s+competencies|competencies|areas?\s+of\s+expertise|expertise|key\s+skills)\s*:?\s*$/i,
  certifications:  /^(certifications?|certificates?|licen[sc]es?|credentials|professional\s+development|training(\s+&\s+certifications?)?)\s*:?\s*$/i,
  summary:         /^(summary|professional\s+summary|profile|objective|about\s+me|career\s+(objective|summary)|executive\s+summary)\s*:?\s*$/i
};

// ─── Contact Extractors ──────────────────────────────────────

function extractEmail(text) {
  const m = text.match(/[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractPhone(text) {
  const m = text.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? m[0].trim() : null;
}

function extractLinkedIn(text) {
  const m = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w\-]+/i);
  if (!m) return null;
  return m[0].startsWith('http') ? m[0] : 'https://' + m[0];
}

function extractCity(text) {
  const m = text.match(/([\w\s\-]+),?\s*(ON|BC|AB|QC|MB|SK|NS|NB|NL|PEI|NT|YT|Ontario|British Columbia|Alberta|Quebec|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland)/i);
  return m ? m[0].trim() : null;
}

function extractName(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    if (!line.includes('@') && !line.match(/^\+?\(?\d{3}/) && !line.includes('http') &&
        line.length > 3 && line.length < 60 && /^[A-Z]/.test(line)) {
      return line;
    }
  }
  return null;
}

function extractHeadline(text) {
  const titlePattern = /\b(estimator|coordinator|manager|supervisor|engineer|director|analyst|specialist|technician|foreman|superintendent|project\s+manager|site\s+manager|quantity\s+surveyor|pm\b|pe\b)\b/i;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    if (titlePattern.test(line) && line.length < 100 && !line.includes('@')) {
      return line;
    }
  }
  return null;
}

// ─── Section Splitter ────────────────────────────────────────

function extractSections(text) {
  const lines = text.split('\n');
  const sections = {};
  let currentSection = 'header';
  let buffer = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let matched = null;

    if (trimmed.length > 0 && trimmed.length < 70) {
      for (const [name, pattern] of Object.entries(SECTION_PATTERNS)) {
        if (pattern.test(trimmed)) { matched = name; break; }
      }
    }

    if (matched) {
      sections[currentSection] = buffer.join('\n');
      currentSection = matched;
      buffer = [];
    } else {
      buffer.push(trimmed);
    }
  }
  sections[currentSection] = buffer.join('\n');
  return sections;
}

// ─── Skills ──────────────────────────────────────────────────

function extractSkills(fullText, skillsSectionText) {
  const combined = (fullText + ' ' + (skillsSectionText || '')).toLowerCase();
  const allSkills = new Set();
  const categorized = {};

  for (const [cat, keywords] of Object.entries(SKILL_CATEGORIES)) {
    categorized[cat] = [];
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        const display = kw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        categorized[cat].push(display);
        allSkills.add(display);
      }
    }
    if (categorized[cat].length === 0) delete categorized[cat];
  }

  // Pull additional skills from skills section (comma/bullet delimited)
  if (skillsSectionText) {
    const raw = skillsSectionText.split(/[\n,•·\-|\/]/);
    const other = [];
    for (const item of raw) {
      const s = item.trim().replace(/^\s*[-•·]\s*/, '');
      if (s.length > 2 && s.length < 60 && /^[a-zA-Z]/.test(s) && !allSkills.has(s)) {
        allSkills.add(s);
        other.push(s);
      }
    }
    if (other.length > 0) {
      categorized['Other'] = (categorized['Other'] || []).concat(other).slice(0, 15);
    }
  }

  return {
    skills: [...allSkills].slice(0, 40),
    skillCategories: categorized
  };
}

// ─── Experience ──────────────────────────────────────────────

function extractExperiences(sectionText) {
  if (!sectionText || sectionText.trim().length < 20) return [];

  const experiences = [];
  const datePattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/gi;
  const blocks = sectionText.split(/\n{2,}/);
  let currentExp = null;

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const blockLower = block.toLowerCase();
    const dates = block.match(datePattern);
    const hasPresentKeyword = /\bpresent\b|\bcurrent\b|\bnow\b/i.test(block);
    const looksLikeHeader = dates || hasPresentKeyword;

    if (looksLikeHeader && lines.length >= 1) {
      if (currentExp) experiences.push(currentExp);

      currentExp = {
        title:     lines[0] || null,
        company:   lines[1] || null,
        location:  null,
        startDate: dates ? dates[0] : null,
        endDate:   dates && dates[1] ? dates[1] : (hasPresentKeyword ? 'Present' : null),
        isCurrent: hasPresentKeyword,
        bullets:   []
      };

      // Extract location from first 3 lines
      for (const ln of lines.slice(0, 4)) {
        if (/,\s*(ON|BC|AB|QC|MB|SK|NS|NB|Ontario|Canada)/i.test(ln)) {
          currentExp.location = ln;
          break;
        }
      }
    } else if (currentExp) {
      for (const ln of lines) {
        const bullet = ln.replace(/^[•\-·▪▸◦]\s*/, '').trim();
        if (bullet.length > 15) currentExp.bullets.push(bullet);
      }
    }
  }

  if (currentExp) experiences.push(currentExp);
  return experiences.slice(0, 10);
}

// ─── Education ───────────────────────────────────────────────

function extractEducations(sectionText) {
  if (!sectionText) return [];
  const educations = [];
  const blocks = sectionText.split(/\n{2,}/);
  const yearPattern = /\b(19|20)\d{2}\b/g;

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const hasInstitution = /university|college|institute|school|polytechnic|academy|cégep/i.test(block);
    if (hasInstitution) {
      const years = block.match(yearPattern) || [];
      educations.push({
        degree:      lines[0] || null,
        institution: lines[1] || null,
        location:    null,
        startDate:   years[0] || null,
        endDate:     years[1] || years[0] || null
      });
    }
  }
  return educations;
}

// ─── Certifications ──────────────────────────────────────────

function extractCertifications(sectionText) {
  if (!sectionText) return [];
  const certs = [];
  const lines = sectionText.split('\n').map(l => l.trim()).filter(l => l.length > 4);
  const yearPat = /\b(19|20)\d{2}\b/;

  for (const line of lines) {
    const yearMatch = line.match(yearPat);
    certs.push({
      name:   line.replace(yearMatch ? yearMatch[0] : '', '').replace(/[-–,|]\s*$/, '').trim(),
      issuer: null,
      year:   yearMatch ? yearMatch[0] : null
    });
  }
  return certs.slice(0, 20);
}

// ─── Other Fields ────────────────────────────────────────────

function extractYearsExperience(text) {
  const explicit = text.match(/(\d+)\+?\s*years?\s*(of\s+)?experience/i);
  if (explicit) return parseInt(explicit[1]);

  const yearPat = /\b(19|20)(\d{2})\b/g;
  const years = [];
  let m;
  while ((m = yearPat.exec(text)) !== null) years.push(parseInt(m[1] + m[2]));
  if (years.length >= 2) {
    const oldest = Math.min(...years);
    const diff = new Date().getFullYear() - oldest;
    if (diff > 0 && diff < 50) return diff;
  }
  return null;
}

function extractDriversLicence(text) {
  const m = text.match(/\b(G2|G1|G|AZ|DZ|BZ|Class\s+[A-G])\b/i);
  return m ? m[0].toUpperCase().replace(/CLASS\s+/, 'Class ') : null;
}

function extractOpenToRelocation(text) {
  return /open\s+to\s+relocation|willing\s+to\s+relocate|relocation\s+considered|available\s+to\s+relocate/i.test(text);
}

function extractAvailability(text) {
  if (/immediate/i.test(text))       return 'Immediate';
  if (/full[-\s]?time/i.test(text))  return 'Full-time';
  if (/part[-\s]?time/i.test(text))  return 'Part-time';
  if (/contract/i.test(text))        return 'Contract';
  return null;
}

function extractSummary(sections) {
  const t = (sections['summary'] || '').trim();
  return t.length >= 30 ? t.substring(0, 1000) : null;
}

// ─── Main Entry Point ────────────────────────────────────────

function parseResume(text) {
  const sections = extractSections(text);
  const { skills, skillCategories } = extractSkills(text, sections['skills'] || '');

  return {
    name:             extractName(text),
    email:            extractEmail(text),
    phone:            extractPhone(text),
    linkedin:         extractLinkedIn(text),
    city:             extractCity(text),
    country:          'Canada',
    headline:         extractHeadline(text),
    summary:          extractSummary(sections),
    yearsExperience:  extractYearsExperience(sections['experience'] || text),
    driversLicence:   extractDriversLicence(text),
    openToRelocation: extractOpenToRelocation(text),
    availability:     extractAvailability(text),
    skills,
    skillCategories,
    experiences:      extractExperiences(sections['experience'] || ''),
    educations:       extractEducations(sections['education'] || ''),
    certifications:   extractCertifications(sections['certifications'] || '')
  };
}

module.exports = { parseResume };
