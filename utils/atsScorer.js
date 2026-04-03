'use strict';

// ============================================================
//  Keyword-based ATS Scorer — no AI, no API credits
//  Uses token matching + phrase matching + construction keywords
// ============================================================

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'i','you','he','she','it','we','they','this','that','these','those',
  'not','no','nor','so','yet','both','either','neither','whether',
  'if','then','because','as','until','while','although','though',
  'all','each','every','any','some','much','more','most','other','than',
  'our','your','their','its','my','his','her','we','us','them','him','her',
  'also','just','only','very','too','even','still','already','now','then',
  'about','above','after','before','between','into','through','during','without'
]);

const CONSTRUCTION_KEYWORDS = [
  'estimat', 'coordinat', 'supervis', 'manag', 'schedul', 'budget',
  'autocad', 'revit', 'procore', 'bluebeam', 'planswift', 'primavera',
  'rfi', 'submittal', 'contract', 'procurement', 'tender', 'bid',
  'residential', 'commercial', 'industrial', 'civil', 'ici',
  'ohsa', 'safety', 'leed', 'building code', 'inspection',
  'construction', 'renovation', 'project', 'site', 'engineer',
  'quantity', 'takeoff', 'drawing', 'specification', 'permit',
  'subcontract', 'trade', 'labour', 'workforce', 'timeline'
];

// ─── Tokenise + phrase extraction ───────────────────────────

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s\-+#.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function extractBigrams(tokens) {
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!STOP_WORDS.has(tokens[i]) && !STOP_WORDS.has(tokens[i + 1])) {
      bigrams.push(tokens[i] + ' ' + tokens[i + 1]);
    }
  }
  return bigrams;
}

// ─── Main scorer ─────────────────────────────────────────────

function scoreATS(resumeText, jobDescription) {
  const resumeLower = resumeText.toLowerCase();
  const jobLower    = jobDescription.toLowerCase();

  const resumeTokenSet = new Set(tokenize(resumeText));
  const jobTokens      = tokenize(jobDescription);
  const jobBigrams     = extractBigrams(jobTokens);

  const uniqueJobKeywords = [...new Set(jobTokens)].filter(w => w.length > 3);
  const uniqueJobBigrams  = [...new Set(jobBigrams)];

  // ── Keyword Score ─────────────────────────────────────────
  const matchedKeywords = uniqueJobKeywords.filter(kw => resumeTokenSet.has(kw));
  const missingKeywords = uniqueJobKeywords.filter(kw => !resumeTokenSet.has(kw));

  const keywordScore = uniqueJobKeywords.length > 0
    ? Math.round((matchedKeywords.length / uniqueJobKeywords.length) * 100)
    : 0;

  // ── Phrase / Bigram Bonus ─────────────────────────────────
  const matchedBigrams = uniqueJobBigrams.filter(bg => resumeLower.includes(bg));
  const bigramBonus    = Math.min(15, matchedBigrams.length * 3);

  // ── Skills Score (construction-specific) ──────────────────
  const jobConstruct    = CONSTRUCTION_KEYWORDS.filter(t => jobLower.includes(t));
  const resumeConstruct = jobConstruct.filter(t => resumeLower.includes(t));

  const skillsScore = jobConstruct.length > 0
    ? Math.round((resumeConstruct.length / jobConstruct.length) * 100)
    : keywordScore;

  // ── Title / Role Match ────────────────────────────────────
  const jobFirstLines = jobDescription.split('\n').slice(0, 5).join(' ').toLowerCase();
  const jobTitleTokens = [...new Set(tokenize(jobFirstLines))].filter(w => w.length > 4);
  const titleMatches   = jobTitleTokens.filter(t => resumeLower.includes(t));

  const titleScore = jobTitleTokens.length > 0
    ? Math.round((titleMatches.length / jobTitleTokens.length) * 100)
    : 50;

  // ── Format Score ──────────────────────────────────────────
  const hasEmail      = /[\w.]+@[\w.]+/.test(resumeText);
  const hasPhone      = /\d{3}[-.\s]\d{3}/.test(resumeText);
  const hasExperience = /experience|employment/i.test(resumeText);
  const hasEducation  = /education|degree|diploma|certificate/i.test(resumeText);
  const hasSkills     = /skills|competencies|expertise/i.test(resumeText);
  const formatChecks  = [hasEmail, hasPhone, hasExperience, hasEducation, hasSkills];
  const formatScore   = Math.round((formatChecks.filter(Boolean).length / formatChecks.length) * 100);

  // ── Overall Score (weighted) ──────────────────────────────
  const raw = (
    keywordScore * 0.40 +
    skillsScore  * 0.30 +
    titleScore   * 0.15 +
    formatScore  * 0.10 +
    bigramBonus  * 0.50
  );
  const score = Math.min(100, Math.round(raw));

  // ── Match Strength ────────────────────────────────────────
  const matchStrength =
    score >= 80 ? 'Excellent' :
    score >= 60 ? 'Good'      :
    score >= 40 ? 'Fair'      : 'Poor';

  // ── Top keywords to display ───────────────────────────────
  const topMatched = matchedKeywords.filter(k => k.length > 4).slice(0, 10);
  const topMissing = missingKeywords.filter(k => k.length > 4).slice(0, 10);

  // ── Suggestions ───────────────────────────────────────────
  const suggestions = [];
  if (keywordScore < 60) suggestions.push('Add more keywords from the job posting to your resume');
  if (skillsScore < 60)  suggestions.push('Include specific tools and software mentioned in the job description');
  if (titleScore < 50)   suggestions.push('Tailor your headline/title to match the position');
  if (!hasEmail)         suggestions.push('Add your email address to the resume');
  if (!hasPhone)         suggestions.push('Add your phone number to the resume');
  if (topMissing.length) suggestions.push(`Consider adding: ${topMissing.slice(0, 4).join(', ')}`);
  if (!suggestions.length) suggestions.push('Strong match — go ahead and submit your application!');

  return {
    score,
    keywordScore,
    skillsScore,
    experienceScore: titleScore,
    titleScore,
    formatScore,
    matchStrength,
    matchedKeywords: topMatched,
    missingKeywords: topMissing,
    suggestions: suggestions.slice(0, 3)
  };
}

module.exports = { scoreATS };
