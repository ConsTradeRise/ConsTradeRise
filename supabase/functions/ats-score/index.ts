// Edge Function: ats-score
// POST /functions/v1/ats-score
// Body: { resumeText, jobDescription, jobId?, resumeId? }
// Scores resume against job description (free, no AI credits)
// Stores result in ats_results table

import { getUserClient, getServiceClient, corsHeaders, json, err } from '../_shared/supabase.ts';

// ─── Stop words ──────────────────────────────
const STOP = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'i','you','he','she','it','we','they','this','that','these','those',
  'not','no','nor','so','yet','both','either','neither','whether',
  'if','then','because','as','until','while','although','though',
  'all','each','every','any','some','much','more','most','other','than',
  'our','your','their','its','my','his','her','also','just','only',
  'very','too','even','still','already','now','about','above','after',
  'before','between','into','through','during','without'
]);

const CONSTRUCTION_KW = [
  'estimat','coordinat','supervis','manag','schedul','budget',
  'autocad','revit','procore','bluebeam','planswift','primavera',
  'rfi','submittal','contract','procurement','tender','bid',
  'residential','commercial','industrial','civil','ici',
  'ohsa','safety','leed','building code','inspection',
  'construction','renovation','project','site','engineer',
  'quantity','takeoff','drawing','specification','permit',
  'subcontract','trade','labour','workforce','timeline'
];

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s\-+#.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

function extractBigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!STOP.has(tokens[i]) && !STOP.has(tokens[i + 1])) {
      out.push(tokens[i] + ' ' + tokens[i + 1]);
    }
  }
  return out;
}

function scoreATS(resumeText: string, jobDescription: string) {
  const resumeLower = resumeText.toLowerCase();
  const jobLower    = jobDescription.toLowerCase();

  const resumeTokenSet = new Set(tokenize(resumeText));
  const jobTokens      = tokenize(jobDescription);
  const jobBigrams     = extractBigrams(jobTokens);

  const uniqueJobKw     = [...new Set(jobTokens)].filter(w => w.length > 3);
  const uniqueJobBigrams = [...new Set(jobBigrams)];

  const matchedKeywords = uniqueJobKw.filter(kw => resumeTokenSet.has(kw));
  const missingKeywords = uniqueJobKw.filter(kw => !resumeTokenSet.has(kw));
  const keywordScore    = uniqueJobKw.length > 0
    ? Math.round((matchedKeywords.length / uniqueJobKw.length) * 100) : 0;

  const matchedBigrams = uniqueJobBigrams.filter(bg => resumeLower.includes(bg));
  const bigramBonus    = Math.min(15, matchedBigrams.length * 3);

  const jobConstruct    = CONSTRUCTION_KW.filter(t => jobLower.includes(t));
  const resumeConstruct = jobConstruct.filter(t => resumeLower.includes(t));
  const skillsScore     = jobConstruct.length > 0
    ? Math.round((resumeConstruct.length / jobConstruct.length) * 100) : keywordScore;

  const jobFirstLines  = jobDescription.split('\n').slice(0, 5).join(' ').toLowerCase();
  const jobTitleTokens = [...new Set(tokenize(jobFirstLines))].filter(w => w.length > 4);
  const titleMatches   = jobTitleTokens.filter(t => resumeLower.includes(t));
  const titleScore     = jobTitleTokens.length > 0
    ? Math.round((titleMatches.length / jobTitleTokens.length) * 100) : 50;

  const formatChecks = [
    /[\w.]+@[\w.]+/.test(resumeText),
    /\d{3}[-.\s]\d{3}/.test(resumeText),
    /experience|employment/i.test(resumeText),
    /education|degree|diploma|certificate/i.test(resumeText),
    /skills|competencies|expertise/i.test(resumeText),
  ];
  const formatScore = Math.round((formatChecks.filter(Boolean).length / formatChecks.length) * 100);

  const raw = (
    keywordScore * 0.40 +
    skillsScore  * 0.30 +
    titleScore   * 0.15 +
    formatScore  * 0.10 +
    bigramBonus  * 0.50
  );
  const score = Math.min(100, Math.round(raw));

  const matchStrength =
    score >= 80 ? 'Excellent' :
    score >= 60 ? 'Good'      :
    score >= 40 ? 'Fair'      : 'Poor';

  const topMatched = matchedKeywords.filter(k => k.length > 4).slice(0, 10);
  const topMissing = missingKeywords.filter(k => k.length > 4).slice(0, 10);

  const suggestions: string[] = [];
  if (keywordScore < 60) suggestions.push('Add more keywords from the job posting to your resume');
  if (skillsScore  < 60) suggestions.push('Include specific tools and software mentioned in the job description');
  if (titleScore   < 50) suggestions.push('Tailor your headline/title to match the position');
  if (!formatChecks[0])  suggestions.push('Add your email address to the resume');
  if (!formatChecks[1])  suggestions.push('Add your phone number to the resume');
  if (topMissing.length) suggestions.push(`Consider adding: ${topMissing.slice(0, 4).join(', ')}`);
  if (!suggestions.length) suggestions.push('Strong match — go ahead and submit your application!');

  return {
    score, keywordScore, skillsScore,
    experienceScore: titleScore, titleScore, formatScore,
    matchStrength,
    matchedKeywords: topMatched,
    missingKeywords: topMissing,
    suggestions: suggestions.slice(0, 3)
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405, origin);

  const auth = req.headers.get('authorization') || '';
  const db   = getUserClient(auth);

  const { data: { user } } = await db.auth.getUser();
  if (!user) return err('Unauthorized', 401, origin);

  const { resumeText, jobDescription, jobId, resumeId } = await req.json();
  if (!resumeText || !jobDescription) {
    return err('resumeText and jobDescription required', 400, origin);
  }

  const result = scoreATS(String(resumeText), String(jobDescription));

  // Persist result with service client (bypasses RLS insert restrictions)
  if (jobId) {
    const svc = getServiceClient();
    await svc.from('ats_results').upsert({
      userId:   user.id,
      jobId,
      resumeId: resumeId || null,
      ...result
    }, { onConflict: 'userId,jobId,resumeId' });
  }

  return json({ result }, 200, origin);
});
