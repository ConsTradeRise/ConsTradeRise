// Edge Function: jobs-aggregate
// Triggered by Supabase cron (every 4 hours) or manually via POST
// Fetches jobs from Adzuna + Jooble, upserts into jobs table

import { getServiceClient, corsHeaders, json, err } from '../_shared/supabase.ts';

const ROLES = [
  'Construction Estimator', 'Project Coordinator', 'Project Manager',
  'Construction Manager', 'Site Supervisor', 'Site Superintendent',
  'Civil Engineer', 'Structural Engineer', 'BIM Coordinator',
  'Carpenter', 'Electrician', 'Plumber', 'HVAC Technician', 'Welder',
  'Ironworker', 'Heavy Equipment Operator', 'Crane Operator', 'Pipefitter',
  'Construction Safety Officer', 'General Labourer', 'Construction Worker'
];

const LOCATION = 'Ontario, Canada';
const TTL_MS   = 4 * 60 * 60 * 1000; // 4 hours

// ─── Adzuna ──────────────────────────────────
async function fetchAdzuna(role: string, location: string) {
  const appId  = Deno.env.get('ADZUNA_APP_ID');
  const appKey = Deno.env.get('ADZUNA_API_KEY');
  if (!appId || !appKey) return [];

  const what  = encodeURIComponent(role);
  const where = encodeURIComponent(location.replace(', Canada', '').trim());
  const url   = `https://api.adzuna.com/v1/api/jobs/ca/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=10&what=${what}&where=${where}&content-type=application/json`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    return (data.results || []).map((j: Record<string, unknown>) => ({
      title:       String(j.title || ''),
      description: String((j.description as string || '').substring(0, 5000)),
      location:    String((j.location as { display_name?: string })?.display_name || location),
      salary:      j.salary_min ? `$${Math.round(Number(j.salary_min) / 1000)}k–$${Math.round((Number(j.salary_max) || Number(j.salary_min)) / 1000)}k` : null,
      jobType:     String(j.contract_time || 'Full-time'),
      companyName: String((j.company as { display_name?: string })?.display_name || 'Unknown'),
      externalUrl: String(j.redirect_url || ''),
      source:      'EXTERNAL',
    })).filter((j: { title: string }) => j.title);
  } catch {
    return [];
  }
}

// ─── Jooble ──────────────────────────────────
async function fetchJooble(role: string, location: string) {
  const key = Deno.env.get('JOOBLE_API_KEY');
  if (!key) return [];

  try {
    const res = await fetch(`https://jooble.org/api/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ keywords: role, location, page: 1 }),
      signal:  AbortSignal.timeout(8000)
    });
    const data = await res.json();
    return (data.jobs || []).slice(0, 10).map((j: Record<string, unknown>) => ({
      title:       String(j.title || ''),
      description: String((j.snippet as string || '').substring(0, 5000)),
      location:    String(j.location || location),
      salary:      j.salary ? String(j.salary) : null,
      jobType:     'Full-time',
      companyName: String(j.company || 'Company'),
      externalUrl: String(j.link || ''),
      source:      'EXTERNAL',
    })).filter((j: { title: string }) => j.title);
  } catch {
    return [];
  }
}

// ─── Upsert to DB ────────────────────────────
async function upsertJobs(jobs: Record<string, unknown>[]) {
  const db         = getServiceClient();
  const expiresAt  = new Date(Date.now() + TTL_MS).toISOString();
  let   saved      = 0;
  let   updated    = 0;

  for (const job of jobs) {
    if (!job.externalUrl || !job.title) continue;

    const { data: existing } = await db
      .from('jobs')
      .select('id')
      .eq('externalUrl', job.externalUrl)
      .maybeSingle();

    if (existing) {
      await db.from('jobs').update({ isActive: true, expiresAt }).eq('id', existing.id);
      updated++;
    } else {
      await db.from('jobs').insert({
        title:       String(job.title       || 'Construction Job').substring(0, 200),
        description: String(job.description || job.title          || '').substring(0, 5000),
        location:    String(job.location    || 'Canada').substring(0, 200),
        salary:      job.salary ? String(job.salary).substring(0, 100) : null,
        jobType:     String(job.jobType     || 'Full-time').substring(0, 50),
        companyName: String(job.companyName || 'Company').substring(0, 200),
        externalUrl: String(job.externalUrl).substring(0, 500),
        source:      'EXTERNAL',
        isActive:    true,
        expiresAt,
        skills:      [],
      });
      saved++;
    }
  }

  return { saved, updated };
}

// ─── Handler ─────────────────────────────────
Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  // Cron key check (prevent unauthorized triggers)
  const cronKey = req.headers.get('x-cron-key');
  const validKey = Deno.env.get('CRON_SECRET');
  if (validKey && cronKey !== validKey) {
    return err('Unauthorized', 401, origin);
  }

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  let allJobs: Record<string, unknown>[] = [];

  for (const role of ROLES) {
    const [adzuna, jooble] = await Promise.allSettled([
      fetchAdzuna(role, LOCATION),
      fetchJooble(role, LOCATION)
    ]);
    if (adzuna.status === 'fulfilled') allJobs.push(...adzuna.value);
    if (jooble.status  === 'fulfilled') allJobs.push(...jooble.value);
    await delay(1500);
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  allJobs = allJobs.filter(j => {
    const url = String(j.externalUrl || '');
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });

  const result = await upsertJobs(allJobs);
  return json({ ok: true, fetched: allJobs.length, ...result }, 200, origin);
});
