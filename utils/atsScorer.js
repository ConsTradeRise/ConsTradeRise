'use strict';

// ============================================================
//  Keyword-based ATS Scorer — construction-industry focused
//  Scores based on: software tools, certifications, named
//  skills, and role-specific keywords from the job description.
//  No generic word inflation. Weights sum to 1.0.
// ============================================================

// ── Stop words (ignored in all scoring) ──────────────────────
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'i','you','he','she','it','we','they','this','that','these','those',
  'not','no','nor','so','yet','both','either','neither','whether',
  'if','then','because','as','until','while','although','though',
  'all','each','every','any','some','much','more','most','other','than',
  'our','your','their','its','my','his','her','us','them','him',
  'also','just','only','very','too','even','still','already','now','then',
  'about','above','after','before','between','into','through','during','without',
  // Generic job-posting filler words — never contribute to score
  'work','team','role','good','need','must','help','able','make','look',
  'join','grow','provide','ensure','support','assist','perform','maintain',
  'responsible','opportunity','company','position','candidate','applicant',
  'required','preferred','strong','excellent','proven','demonstrated',
  'ability','skills','experience','knowledge','understanding','familiarity',
  'minimum','years','year','month','day','time','full','part','based',
  'within','across','including','following','related','similar','various',
  'new','current','existing','multiple','different','general','specific',
  'high','low','large','small','well','own','key','lead','working'
]);

// ── Named software tools (exact substring match, high value) ─
const SOFTWARE_TOOLS = [
  'autocad','revit','procore','bluebeam','planswift','primavera','heavybid',
  'navisworks','sketchup','bim 360','bim360','fieldwire','buildertrend',
  'microsoft project','ms project','p6','hard dollar','sage 300','sage300',
  'timberline','accubid','on-screen takeoff','stack cto','countfire',
  'trimble','hcss','b2w','viewpoint','cosential','corecon',
  'excel','word','outlook','powerpoint',   // generic but common in construction roles
  'teams','sharepoint',
];

// ── Construction-specific skills & role keywords ──────────────
const CONSTRUCTION_SKILLS = [
  // Estimating & Cost
  'estimat','quantity takeoff','cost estimate','bid','tender','unit price',
  'value engineer','cost control','budget','change order','contingency',
  'hard cost','soft cost','material takeoff','labour cost',

  // Project Management
  'project manag','site supervis','superintendent','coordinat','schedul',
  'gantt','milestone','critical path','rfi','submittal','procurement',
  'subcontract','trade coordinat','workforce','progress report',
  'commissioning','closeout','punch list','substantial completion',

  // Trades & Scope
  'concrete','structural steel','masonry','framing','drywall','roofing',
  'mechanical','electrical','hvac','plumbing','carpentry','millwork',
  'earthwork','grading','sitework','paving','landscaping','demolition',
  'ici','residential','commercial','industrial','civil','infrastructure',
  'high-rise','low-rise','mixed-use','renovation','retrofit',

  // Codes, Safety & Certifications
  'ohsa','ohse','whmis','working at heights','first aid','cpr','aed',
  'building code','ontario building code','obc','nbc','fire code',
  'leed','boma','gold seal','red seal','pmp','cca','rao','eto',
  'site safety','hazard assessment','ppe','lockout tagout',

  // Drawings & Documentation
  'drawing','blueprint','specification','shop drawing','as-built',
  'permit','permit application','zoning','building permit','variance',
  'contract admin','progress draw','lien','holdback',

  // General Roles
  'general contractor','project manager','project coordinator',
  'estimator','site supervisor','project engineer','field engineer',
  'construction manager','owner representative','clerk of works',
];

// ── Tokenise ──────────────────────────────────────────────────
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s\-+#]/g, ' ')   // strip punctuation (incl. periods)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ── Software tool score ───────────────────────────────────────
// Only counts tools that appear in the job description
function scoreSoftware(resumeLower, jobLower) {
  const jobTools    = SOFTWARE_TOOLS.filter(t => jobLower.includes(t));
  if (jobTools.length === 0) return null;   // not applicable
  const matchedTools = jobTools.filter(t => resumeLower.includes(t));
  return Math.round((matchedTools.length / jobTools.length) * 100);
}

// ── Construction skill score ──────────────────────────────────
// Partial/stem matching against CONSTRUCTION_SKILLS
function scoreConstructionSkills(resumeLower, jobLower) {
  const jobSkills    = CONSTRUCTION_SKILLS.filter(t => jobLower.includes(t));
  if (jobSkills.length === 0) return null;
  const matchedSkills = jobSkills.filter(t => resumeLower.includes(t));
  return Math.round((matchedSkills.length / jobSkills.length) * 100);
}

// ── Relevant keyword score ────────────────────────────────────
// Only tokens that are meaningful (length ≥ 5 and not stop words)
// matched between resume and job description
function scoreKeywords(resumeText, jobDescription) {
  const resumeTokenSet = new Set(tokenize(resumeText));
  const jobTokens      = [...new Set(tokenize(jobDescription))];
  // Filter to only "substantive" tokens (longer, not generic)
  const meaningfulJobTokens = jobTokens.filter(w => w.length >= 5);
  if (meaningfulJobTokens.length === 0) return { score: 0, matched: [], missing: [] };

  const matched = meaningfulJobTokens.filter(kw => resumeTokenSet.has(kw));
  const missing = meaningfulJobTokens.filter(kw => !resumeTokenSet.has(kw));
  return {
    score: Math.round((matched.length / meaningfulJobTokens.length) * 100),
    matched,
    missing,
  };
}

// ── Title / role match ────────────────────────────────────────
function scoreTitleMatch(resumeLower, jobDescription) {
  const firstLines  = jobDescription.split('\n').slice(0, 4).join(' ').toLowerCase();
  const titleTokens = [...new Set(tokenize(firstLines))].filter(w => w.length >= 5);
  if (titleTokens.length === 0) return 50;
  const matched = titleTokens.filter(t => resumeLower.includes(t));
  return Math.round((matched.length / titleTokens.length) * 100);
}

// ── Format / completeness score ───────────────────────────────
function scoreFormat(resumeText) {
  const checks = [
    /[\w.]+@[\w.]+/.test(resumeText),                          // email
    /\d{3}[-.\s]\d{3}/.test(resumeText),                      // phone
    /experience|employment|work history/i.test(resumeText),    // experience section
    /education|degree|diploma|certificate/i.test(resumeText),  // education
    /skills|competencies|expertise|proficienc/i.test(resumeText), // skills
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

// ── Main scorer ───────────────────────────────────────────────
function scoreATS(resumeText, jobDescription) {
  const resumeLower = resumeText.toLowerCase();
  const jobLower    = jobDescription.toLowerCase();

  // Component scores
  const softwareScore   = scoreSoftware(resumeLower, jobLower);
  const skillsScore     = scoreConstructionSkills(resumeLower, jobLower);
  const { score: kwScore, matched: matchedKw, missing: missingKw } =
    scoreKeywords(resumeText, jobDescription);
  const titleScore      = scoreTitleMatch(resumeLower, jobDescription);
  const formatScore     = scoreFormat(resumeText);

  // Adaptive weighting:
  //   If both software and skills data exist → use all four
  //   If only one dimension is applicable   → redistribute weight
  //   Weights always sum to 1.0
  let weightedScore;
  if (softwareScore !== null && skillsScore !== null) {
    weightedScore =
      softwareScore * 0.30 +
      skillsScore   * 0.30 +
      kwScore       * 0.25 +
      titleScore    * 0.10 +
      formatScore   * 0.05;
  } else if (softwareScore !== null) {
    weightedScore =
      softwareScore * 0.40 +
      kwScore       * 0.35 +
      titleScore    * 0.15 +
      formatScore   * 0.10;
  } else if (skillsScore !== null) {
    weightedScore =
      skillsScore * 0.45 +
      kwScore     * 0.35 +
      titleScore  * 0.10 +
      formatScore * 0.10;
  } else {
    // No construction-specific data — fall back to keyword + format
    weightedScore =
      kwScore     * 0.75 +
      titleScore  * 0.15 +
      formatScore * 0.10;
  }

  const score = Math.min(100, Math.round(weightedScore));

  const matchStrength =
    score >= 80 ? 'Excellent' :
    score >= 60 ? 'Good'      :
    score >= 40 ? 'Fair'      : 'Poor';

  // Top matched / missing (filter out very short tokens for display)
  const topMatched = matchedKw.filter(k => k.length > 4).slice(0, 10);
  const topMissing = missingKw.filter(k => k.length > 4).slice(0, 10);

  // Suggestions
  const suggestions = [];
  if (softwareScore !== null && softwareScore < 60)
    suggestions.push('Add specific software tools mentioned in the job posting (e.g. Procore, Bluebeam, AutoCAD)');
  if (skillsScore !== null && skillsScore < 60)
    suggestions.push('Include construction-specific skills and certifications from the job description');
  if (kwScore < 50)
    suggestions.push('Mirror key terms and phrases from the job posting in your resume');
  if (titleScore < 50)
    suggestions.push('Tailor your headline or summary to match the posted role title');
  if (!/[\w.]+@[\w.]+/.test(resumeText))
    suggestions.push('Add your email address to the resume');
  if (!/\d{3}[-.\s]\d{3}/.test(resumeText))
    suggestions.push('Add your phone number to the resume');
  if (topMissing.length)
    suggestions.push(`Consider adding: ${topMissing.slice(0, 5).join(', ')}`);
  if (!suggestions.length)
    suggestions.push('Strong match — go ahead and submit your application!');

  return {
    score,
    keywordScore:    kwScore,
    skillsScore:     skillsScore ?? kwScore,
    softwareScore:   softwareScore ?? null,
    experienceScore: titleScore,
    titleScore,
    formatScore,
    matchStrength,
    matchedKeywords: topMatched,
    missingKeywords: topMissing,
    suggestions: suggestions.slice(0, 3),
  };
}

module.exports = { scoreATS };
