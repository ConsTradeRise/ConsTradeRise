// Edge Function: parse-resume
// POST /functions/v1/parse-resume  (multipart/form-data, field: "resume")
// Accepts PDF or DOCX, extracts text, runs rule-based parsing
// Stores parsed data in profile + creates resume record
// No AI credits used — pure rule-based extraction

import { getUserClient, getServiceClient, corsHeaders, json, err } from '../_shared/supabase.ts';

// ─── PDF text extraction (pdf.js port for Deno) ──────────────
async function extractPdfText(buffer: Uint8Array): Promise<string> {
  // Use pdfco or pdf-parse via dynamic import for Deno
  // Fallback: convert buffer to base64 and extract text blocks
  // For Edge Functions, we use the getDocument approach with pdf-dist
  const { getDocument } = await import('https://cdn.skypack.dev/pdfjs-dist@3.11.174/build/pdf.min.js');
  const doc   = await getDocument({ data: buffer }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page    = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((item: { str: string }) => item.str).join(' '));
  }
  return texts.join('\n');
}

// ─── Rule-based resume parser ────────────────────────────────
function parseResume(text: string) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Email
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  const email = emailMatch?.[0] || null;

  // Phone
  const phoneMatch = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  const phone = phoneMatch?.[0]?.trim() || null;

  // LinkedIn
  const linkedinMatch = text.match(/linkedin\.com\/in\/[\w-]+/i);
  const linkedin = linkedinMatch ? `https://${linkedinMatch[0]}` : null;

  // Name (first non-empty line that looks like a name)
  const nameLine = lines.find(l =>
    l.length > 3 && l.length < 60 &&
    /^[A-Z][a-z]+ [A-Z][a-z]+/.test(l) &&
    !/@/.test(l) && !/http/.test(l)
  ) || null;

  // City/province
  const locationMatch = text.match(
    /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(ON|BC|AB|QC|MB|SK|NS|NB|PE|NL|NT|YT|NU|Ontario|British Columbia|Alberta|Quebec|Manitoba|Saskatchewan)\b/
  );
  const city = locationMatch
    ? `${locationMatch[1]}, ${locationMatch[2]}`
    : null;

  // Headline (line after name that isn't contact info)
  const nameIdx = nameLine ? lines.indexOf(nameLine) : -1;
  const headline = nameIdx >= 0
    ? (lines.slice(nameIdx + 1).find(l =>
        l.length > 10 && l.length < 120 &&
        !/@/.test(l) && !/\d{3}[-.]?\d{3}/.test(l) && !/linkedin/i.test(l)
      ) || null)
    : null;

  // Skills — find section, extract comma/bullet separated items
  const skillsIdx = lines.findIndex(l => /^skills?|^core competencies|^technical skills/i.test(l));
  let skills: string[] = [];
  if (skillsIdx >= 0) {
    const skillLines = lines.slice(skillsIdx + 1, skillsIdx + 8);
    skills = skillLines
      .join(' ')
      .split(/[,|•·\n]/)
      .map(s => s.trim())
      .filter(s => s.length > 2 && s.length < 60);
  }

  // Years experience (look for numbers near "year" or "experience")
  const expMatch = text.match(/(\d+)\+?\s*years?\s*(of\s*)?(experience|exp)/i);
  const yearsExperience = expMatch ? parseInt(expMatch[1]) : null;

  // Availability keywords
  const availMatch = text.match(/\b(immediate|full.time|part.time|contract|available|looking)\b/i);
  const availability = availMatch ? availMatch[0] : null;

  // Driver's licence
  const licenceMatch = text.match(/\b(class\s*[A-G]|[A-G]\s*licence|G2|AZ|DZ|driver.s licence)\b/i);
  const driversLicence = licenceMatch?.[0] || null;

  // Open to relocation
  const openToRelocation = /willing to relocate|open to relocation|relocation available/i.test(text);

  // Summary (paragraph after contact info, before experience)
  const summaryIdx = lines.findIndex(l => /^(summary|profile|objective|about)/i.test(l));
  let summary: string | null = null;
  if (summaryIdx >= 0) {
    const block = lines.slice(summaryIdx + 1, summaryIdx + 6)
      .filter(l => l.length > 20 && !/^(experience|education|skills)/i.test(l));
    summary = block.join(' ').substring(0, 500) || null;
  }

  return {
    name:            nameLine,
    email,
    phone,
    linkedin,
    city,
    headline,
    summary,
    skills,
    yearsExperience,
    availability,
    driversLicence,
    openToRelocation
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

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return err('Expected multipart/form-data', 400, origin);
  }

  const formData = await req.formData();
  const file     = formData.get('resume') as File | null;
  if (!file) return err('No file uploaded (field: resume)', 400, origin);

  if (file.size > 5 * 1024 * 1024) return err('File too large. Max 5MB.', 400, origin);

  const ext = file.name.toLowerCase().split('.').pop();
  if (!['pdf', 'doc', 'docx'].includes(ext || '')) {
    return err('Only PDF and Word (.docx) files are allowed', 400, origin);
  }

  let text = '';
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (ext === 'pdf') {
      text = await extractPdfText(buffer);
    } else {
      // DOCX: extract raw text from XML inside ZIP
      const { unzipSync, strFromU8 } = await import('https://deno.land/x/fflate@0.8.2/deno.js');
      const unzipped = unzipSync(buffer);
      const wordXml  = unzipped['word/document.xml'];
      if (wordXml) {
        text = strFromU8(wordXml)
          .replace(/<w:t[^>]*>/g, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  } catch (e) {
    console.error('[parse-resume] extract error:', e);
    return err('Failed to read file. Please try a different file.', 400, origin);
  }

  if (!text || text.trim().length < 50) {
    return err('Could not extract text from file. Please try a different file.', 400, origin);
  }

  const parsed    = parseResume(text);
  const svc       = getServiceClient();
  let   fileUrl: string | null = null;
  let   profileSaved = false;

  // Upload to Supabase Storage
  try {
    const filePath = `${user.id}/${Date.now()}.${ext}`;
    const { error: upErr } = await svc.storage
      .from('resumes')
      .upload(filePath, await file.arrayBuffer(), {
        contentType: file.type || 'application/octet-stream',
        upsert: false
      });
    if (!upErr) {
      const { data: urlData } = svc.storage.from('resumes').getPublicUrl(filePath);
      fileUrl = urlData?.publicUrl || null;
    }
  } catch (_) { /* storage optional */ }

  // Save resume record
  const { data: resume } = await svc.from('resumes').insert({
    userId:      user.id,
    name:        file.name,
    content:     text.substring(0, 10000),
    fileUrl,
    aiGenerated: false
  }).select().single();

  // Auto-populate profile from parsed data
  try {
    const profileData: Record<string, unknown> = {};
    if (parsed.phone)           profileData.phone           = parsed.phone;
    if (parsed.email)           profileData.email           = parsed.email;
    if (parsed.linkedin)        profileData.linkedin        = parsed.linkedin;
    if (parsed.headline)        profileData.headline        = parsed.headline;
    if (parsed.summary)         profileData.summary         = parsed.summary;
    if (parsed.yearsExperience) profileData.yearsExperience = parsed.yearsExperience;
    if (parsed.availability)    profileData.availability    = parsed.availability;
    if (parsed.driversLicence)  profileData.driversLicence  = parsed.driversLicence;
    if (parsed.openToRelocation !== undefined) profileData.openToRelocation = parsed.openToRelocation;
    if (parsed.city) {
      const parts = parsed.city.split(',');
      profileData.city     = parts[0]?.trim();
      profileData.province = parts[1]?.trim();
      profileData.location = parsed.city;
    }
    if (parsed.skills?.length) profileData.skills = parsed.skills;

    if (Object.keys(profileData).length > 0) {
      await svc.from('profiles')
        .upsert({ userId: user.id, ...profileData }, { onConflict: 'userId' });
      profileSaved = true;
    }
  } catch (e) {
    console.warn('[parse-resume] profile save failed:', e);
  }

  return json({
    parsed,
    rawText:      text.substring(0, 3000),
    profileSaved,
    fileUrl,
    resumeId:     resume?.id || null
  }, 200, origin);
});
