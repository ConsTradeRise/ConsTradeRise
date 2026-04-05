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
  // Match "City, Province" without crossing newlines or pipe separators
  const m = text.match(/([^\n,|·•]{2,30}),\s*(ON|BC|AB|QC|MB|SK|NS|NB|NL|PEI|NT|YT|Ontario|British Columbia|Alberta|Quebec|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland)\b/i);
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
  const titlePattern = /\b(estimator|coordinator|manager|supervisor|engineer|director|analyst|specialist|technician|foreman|superintendent|project\s+manager|site\s+manager|quantity\s+surveyor|inspector|planner|scheduler|safety\s+officer|pm\b|pe\b|cet\b)\b/i;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 15)) {
    if (titlePattern.test(line) && line.length < 150 && !line.includes('@') && !line.match(/^\+?\d/)) {
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

  // Pull additional skills from skills section (comma/bullet/pipe/slash delimited)
  if (skillsSectionText) {
    const raw = skillsSectionText.split(/[\n,•·▪▸◦\-\|\/]/);
    const other = [];
    for (const item of raw) {
      const s = item.trim().replace(/^\s*[-•·▪▸◦\*]\s*/, '').replace(/\s+/g, ' ');
      if (s.length > 2 && s.length < 80 && /^[a-zA-Z0-9]/.test(s) && !allSkills.has(s) && !/^\d+$/.test(s)) {
        allSkills.add(s);
        other.push(s);
      }
    }
    if (other.length > 0) {
      categorized['Other'] = (categorized['Other'] || []).concat(other).slice(0, 20);
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

  const datePat    = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}/gi;
  const yearPat    = /\b(19|20)\d{2}\b/g;
  const bulletPat  = /^[•\-·▪▸◦\*]\s*/;
  const presentPat = /\bpresent\b|\bcurrent\b/i;
  const locPat     = /\s*·\s*[A-Z][A-Za-z\s]+,\s*(ON|BC|AB|QC|MB|SK|NS|NB|NT|YT|PEI|Ontario|British Columbia|Alberta|Quebec|Canada)|,\s*(ON|BC|AB|QC|MB|SK|NS|NB|NT|YT|PEI|Ontario|British Columbia|Alberta|Quebec|Canada)/i;

  const lines = sectionText.split('\n').map(l => l.trim());
  const experiences = [];

  // Detect which lines are "date lines" (contain month+year or year range)
  // Common resume patterns:
  //   Pattern A: Title / Company / Dates / Bullets
  //   Pattern B: Title | Company | Location / Dates / Bullets
  //   Pattern C: Title / Company, Location / Dates / Bullets

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }

    const hasDates   = datePat.test(line) || (yearPat.test(line) && line.match(/\b(19|20)\d{2}\b/g)?.length >= 1);
    const hasPresent = presentPat.test(line);
    const isBullet   = bulletPat.test(line);
    datePat.lastIndex = 0; yearPat.lastIndex = 0;

    if ((hasDates || hasPresent) && !isBullet && line.length < 140) {
      // This is the date line — look back for title and company
      const prevLine  = i > 0 ? lines[i - 1] : '';
      const prevLine2 = i > 1 ? lines[i - 2] : '';

      // Extract dates from this line
      const datesFound = line.match(datePat) || [];
      datePat.lastIndex = 0;
      const yearsFound  = line.match(/\b(19|20)\d{2}\b/g) || [];
      const startDate   = datesFound[0] || yearsFound[0] || null;
      const endDate     = datesFound[1] || yearsFound[1] || (hasPresent ? 'Present' : null);

      // Determine title and company from context
      // If previous non-empty line looks like a company (has · or , or known pattern):
      let title   = null;
      let company = null;
      let location = null;

      // Detect if date line itself has title embedded: "Estimator — Jun 2023 - Present"
      const inlineTitle = line.replace(/\s*[-–]\s*\d{4}.*$/, '')
                              .replace(datePat, '').replace(/[-–|,·]\s*$/, '').trim();
      datePat.lastIndex = 0;

      if (inlineTitle && inlineTitle.length > 5 && inlineTitle.length < 80 &&
          !/^\d/.test(inlineTitle) &&
          !/^[-–\s]+$/.test(inlineTitle) &&
          !/^[-–]/.test(inlineTitle) &&
          !/^\s*(present|current)\s*$/i.test(inlineTitle)) {
        // Title is embedded in the date line
        title = inlineTitle;
        if (prevLine && !prevLine.match(datePat) && !bulletPat.test(prevLine)) {
          datePat.lastIndex = 0;
          company = prevLine;
          if (locPat.test(company)) { location = company; company = null; }
          if (prevLine2 && !bulletPat.test(prevLine2) && !prevLine2.match(datePat)) {
            datePat.lastIndex = 0;
            // prevLine2 might be the actual title if company is in prevLine
            if (company && !locPat.test(prevLine2)) title = prevLine2;
          }
        }
      } else {
        // Normal pattern: lines above are title / company
        if (prevLine && !bulletPat.test(prevLine) && !prevLine.match(datePat)) {
          datePat.lastIndex = 0;
          company = prevLine;
          // Check if company line has location embedded (e.g. "Nextgen Exterior Inc. · Newmarket, ON")
          if (locPat.test(company)) {
            const locMatch = company.match(locPat);
            location = locMatch ? locMatch[0].trim().replace(/^[·•,\s]+/, '') : null;
            company  = company.replace(locPat, '').replace(/[·•,\s]+$/, '').trim();
          }
          if (prevLine2 && !bulletPat.test(prevLine2) && !prevLine2.match(datePat)) {
            datePat.lastIndex = 0;
            title = prevLine2;
          } else {
            title = company;
            company = null;
          }
        } else {
          title = line.replace(datePat, '').replace(/[-–|,]\s*$/, '').trim() || 'Role';
          datePat.lastIndex = 0;
        }
      }

      datePat.lastIndex = 0;

      // Collect bullet lines that follow
      const bullets = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next) { j++; continue; }
        const nextHasDates   = datePat.test(next) || yearPat.test(next);
        const nextHasPresent = presentPat.test(next);
        datePat.lastIndex = 0; yearPat.lastIndex = 0;
        // Stop if we hit another date line (= next job)
        if ((nextHasDates || nextHasPresent) && !bulletPat.test(next) && next.length < 140) break;
        // Only collect as bullet if it starts with a bullet char OR is a substantial sentence (>= 45 chars)
        // Short un-bulleted lines are likely the title/company header of the next experience
        const hasBulletChar = bulletPat.test(next);
        if (!hasBulletChar && next.length < 45) { j++; continue; }
        const bullet = next.replace(bulletPat, '').replace(/^[-–]\s*/, '').trim();
        if (bullet.length > 8) bullets.push(bullet);
        j++;
      }

      if (title && title.length > 1) {
        experiences.push({ title, company: company || null, location: location || null,
          startDate, endDate, isCurrent: hasPresent, bullets });
      }
      i = j; // skip past bullets
    } else {
      i++;
    }
  }

  return experiences.slice(0, 10);
}

// ─── Education ───────────────────────────────────────────────

function extractEducations(sectionText) {
  if (!sectionText) return [];
  const educations = [];
  const yearPattern = /\b(19|20)\d{2}\b/g;
  const monthYearPat = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\b(19|20)\d{2}\b/gi;
  const instKeywords = /university|college|institute|school|polytechnic|academy|cégep|lambton|seneca|george brown|humber|conestoga|mohawk|cambrian|confederation/i;

  // Try double-newline blocks first, then single-newline grouping
  let blocks = sectionText.split(/\n{2,}/);
  if (blocks.length <= 1) blocks = sectionText.split('\n').reduce((acc, line) => {
    if (!line.trim()) { acc.push([]); } else { acc[acc.length - 1].push(line.trim()); }
    return acc;
  }, [[]]).filter(g => g.length);

  for (const block of blocks) {
    const lines = Array.isArray(block) ? block.filter(Boolean) : block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const blockText = lines.join(' ');
    const hasInstitution = instKeywords.test(blockText);
    if (!hasInstitution) continue;

    const dates = blockText.match(monthYearPat) || [];
    const years  = blockText.match(yearPattern) || [];

    // Find institution line (contains school keyword)
    let degreeIdx = 0;
    let instIdx   = lines.findIndex(l => instKeywords.test(l));
    if (instIdx > 0) degreeIdx = 0;
    else if (instIdx === 0) degreeIdx = -1; // institution is first line

    // Location: line with city/province pattern
    const locLine = lines.find(l => /,\s*(ON|BC|AB|QC|MB|SK|NS|NB|Ontario|Canada|Toronto|India|Nepal|UK)/i.test(l));

    educations.push({
      degree:      degreeIdx >= 0 ? lines[degreeIdx] : null,
      institution: instIdx >= 0   ? lines[instIdx]   : lines[0],
      location:    locLine || null,
      startDate:   dates[0] || years[0] || null,
      endDate:     dates[1] || years[1] || dates[0] || years[0] || null
    });
  }
  return educations.slice(0, 6);
}

// ─── Certifications ──────────────────────────────────────────

function extractCertifications(sectionText) {
  if (!sectionText) return [];
  const certs = [];
  const lines = sectionText.split('\n').map(l => l.trim()).filter(l => l.length > 4);
  const yearPat    = /\b(19|20)\d{2}\b/;
  const monthPat   = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}/i;
  // Known issuers
  const issuerPat  = /\b(google|coursera|udemy|microsoft|amazon|aws|pmi|csc|ospe|oacett|red seal|red cross|whmis|worksafebc|ontario|columbia|procore|autodesk|linkedin|simplilearn|uc\s+irvine|university|college|institute|national\s+taiwan)\b/i;

  for (const line of lines) {
    const yearMatch  = line.match(monthPat) || line.match(yearPat);
    const yearStr    = yearMatch ? yearMatch[0] : null;

    // Split on — or | or , or — to separate name from issuer
    const parts   = line.split(/\s*[—|\|,–]\s*/);
    let name      = parts[0] || line;
    let issuer    = null;

    // Remove year from name
    name = name.replace(yearStr || '', '').replace(/[-–,|]\s*$/, '').trim();

    // Find issuer: look in remaining parts for issuer pattern, or extract from full line
    for (const part of parts.slice(1)) {
      if (issuerPat.test(part)) {
        issuer = part.replace(/\s*\(\s*(19|20)\d{2}\s*\)/, '').replace(/\b(19|20)\d{2}\b/g, '').replace(/[-–,\s]+$/, '').trim();
        break;
      }
    }
    if (!issuer) {
      // Try extracting issuer in parentheses: "Certificate (Issuer - Year)"
      const parenMatch = line.match(/\(([^)]+)\)/);
      if (parenMatch) {
        const inside = parenMatch[1];
        if (issuerPat.test(inside) || inside.length < 60) {
          issuer = inside.replace(yearStr || '', '').replace(/\b(19|20)\d{2}\b/g, '').replace(/[-–,\s]+$/, '').trim();
          // Also strip the parenthetical from the name
          name = name.replace(/\s*\([^)]*\)/, '').replace(/[-–,|]\s*$/, '').trim();
        }
      }
    }
    if (!issuer && issuerPat.test(line)) {
      const m = line.match(issuerPat);
      if (m) issuer = m[0];
    }

    if (name.length > 3) {
      certs.push({ name, issuer: issuer || null, year: yearStr || null });
    }
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
    yearsExperience:  extractYearsExperience(text),
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
