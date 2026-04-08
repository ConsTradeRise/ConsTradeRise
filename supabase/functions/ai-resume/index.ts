// Edge Function: ai-resume
// POST /functions/v1/ai-resume
// Body: { action, ...params }
//
// Actions:
//   generate    — generate resume content from raw input
//   exp-bullets — rewrite experience bullets
//   cover-letter — generate cover letter
//   tailor      — tailor resume to a specific job (saves version to DB)
//   interview-prep — generate interview Q&A
//   follow-up   — generate post-interview follow-up email

import { getUserClient, getServiceClient, corsHeaders, json, err } from '../_shared/supabase.ts';

const MODEL = 'claude-sonnet-4-6';

async function callClaude(
  apiKey: string,
  system: string,
  userContent: string,
  maxTokens = 2000
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json'
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: maxTokens,
      system,
      messages:   [{ role: 'user', content: userContent }]
    })
  });

  if (!res.ok) {
    const e = await res.text();
    throw new Error(`Claude API error ${res.status}: ${e}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
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

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return err('AI features not configured', 503, origin);

  const body   = await req.json();
  const action = String(body.action || '');

  try {
    switch (action) {

      case 'generate': {
        const { systemPrompt, userPrompt, maxTokens } = body;
        if (!userPrompt) return err('userPrompt required', 400, origin);
        const content = await callClaude(apiKey, systemPrompt || '', userPrompt, maxTokens || 2000);
        return json({ content }, 200, origin);
      }

      case 'exp-bullets': {
        const { rawExperience, jobTitle, company } = body;
        if (!rawExperience) return err('rawExperience required', 400, origin);
        const system = `You are a professional Canadian resume writer for construction and trades.
Convert raw experience descriptions into 3-5 concise, impactful bullet points using CAR format (Context, Action, Result).
Use strong action verbs. Be specific. Do not invent facts. Output bullets only, one per line.`;
        const content = await callClaude(apiKey, system,
          `Job Title: ${jobTitle || 'Construction Professional'}\nCompany: ${company || ''}\n\nRaw experience:\n${rawExperience}`,
          600);
        return json({ content }, 200, origin);
      }

      case 'cover-letter': {
        const { systemPrompt, userPrompt, maxTokens } = body;
        if (!userPrompt) return err('userPrompt required', 400, origin);
        const system = systemPrompt || `You are a professional Canadian career coach specializing in construction and trades.
Write concise, professional cover letters. Maximum 300 words. No fluff. Output the cover letter text only.`;
        const content = await callClaude(apiKey, system, userPrompt, maxTokens || 1000);
        return json({ content }, 200, origin);
      }

      case 'tailor': {
        const { resumeId, jobId } = body;
        if (!resumeId || !jobId) return err('resumeId and jobId required', 400, origin);

        const svc = getServiceClient();

        const { data: resume } = await svc.from('resumes').select('*').eq('id', resumeId).single();
        if (!resume || resume.userId !== user.id) return err('Resume not found', 404, origin);
        if (!resume.content) return err('Resume has no content to tailor', 400, origin);

        const { data: job } = await svc.from('jobs')
          .select('id, title, description, skills, companyName, location')
          .eq('id', jobId).single();
        if (!job) return err('Job not found', 404, origin);

        const system = `You are a professional Canadian resume writer specializing in construction and trades.
Tailor the resume to match the job posting.
Rules:
- Keep all facts accurate — do NOT fabricate experience, employers, or dates
- Reorder bullets to front-load the most relevant experience
- Add job-relevant keywords naturally throughout
- Match job's required skills in the Skills section
- Output the complete tailored resume in plain text only`;

        const userPrompt = `JOB POSTING:
Title: ${job.title}
Company: ${job.companyName || 'Company'}
Location: ${job.location}
Required Skills: ${(job.skills || []).join(', ')}
Description:
${String(job.description || '').substring(0, 2000)}

ORIGINAL RESUME:
${String(resume.content).substring(0, 5000)}

Rewrite the resume to be optimally tailored for this job. Output the complete resume text only.`;

        const tailoredContent = await callClaude(apiKey, system, userPrompt, 3000);
        if (!tailoredContent || tailoredContent.length < 100) {
          return err('AI returned empty response. Please try again.', 500, origin);
        }

        // Get next version number
        const { data: lastVer } = await svc.from('resume_versions')
          .select('version')
          .eq('resumeId', resumeId)
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle();

        const nextVersion = (lastVer?.version || 0) + 1;
        const label = `Tailored for ${job.title}${job.companyName ? ` @ ${job.companyName}` : ''}`.substring(0, 100);

        const { data: version } = await svc.from('resume_versions').insert({
          resumeId,
          userId:      user.id,
          version:     nextVersion,
          label,
          content:     tailoredContent.substring(0, 15000),
          tailoredFor: jobId,
          aiGenerated: true
        }).select().single();

        return json({ version, tailoredContent, job: { id: job.id, title: job.title, company: job.companyName } }, 200, origin);
      }

      case 'interview-prep': {
        const { jobTitle, company, jobDesc, candidateName, role, skills } = body;
        const system = `You are a Canadian construction industry interview coach.
Generate 8 targeted interview questions with strong model answers. Format: Q: [question]\nA: [2-3 sentence answer]`;
        const userPrompt = `Candidate: ${candidateName || 'Candidate'} — ${role || 'Construction Professional'}
Skills: ${skills || 'Construction skills'}
Job: ${jobTitle || 'Position'} at ${company || 'Company'}
Description: ${String(jobDesc || '').substring(0, 1500)}

Generate 8 interview Q&A pairs.`;
        const content = await callClaude(apiKey, system, userPrompt, 2000);
        return json({ content }, 200, origin);
      }

      case 'follow-up': {
        const { candidateName, jobTitle, company, interviewDate, interviewerName } = body;
        const system = `You are a professional career coach. Write a concise post-interview follow-up email for a Canadian construction professional. Under 150 words. Professional tone.`;
        const userPrompt = `Candidate: ${candidateName || 'Candidate'}
Job: ${jobTitle || 'Position'} at ${company || 'Company'}
Interview date: ${interviewDate || 'recently'}
Interviewer: ${interviewerName || 'Hiring Manager'}`;
        const content = await callClaude(apiKey, system, userPrompt, 400);
        return json({ content }, 200, origin);
      }

      default:
        return err(`Unknown action: ${action}`, 400, origin);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ai-resume]', msg);
    return err(msg, 500, origin);
  }
});
