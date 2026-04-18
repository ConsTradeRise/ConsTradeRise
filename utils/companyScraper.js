'use strict';
// Shared company job scraping logic — used by admin endpoint and scheduled task

const https  = require('https');
const prisma  = require('./prisma');
const { fetchFullDescription, closeBrowser } = require('./fetchJobDescription');

const SCRAPE_COMPANIES = [
  'PCL Construction', 'EllisDon', 'Aecon', 'Graham Construction', 'Bird Construction',
  'Ledcor', 'Pomerleau', 'Chandos Construction', 'Bondfield Construction', 'Buttcon',
  'Eastern Construction', 'Taggart Construction', 'Maple Reinders', 'Kenaidan',
  'Vanbots Construction', 'M. Sullivan & Son', 'Clark Construction',
  'Skanska Canada', 'Turner Construction', 'AECOM', 'Stantec',
  'Mattamy Homes', 'Great Gulf', 'Menkes', 'Ainsworth',
  'Johnson Controls', 'Williams Mechanical', 'Pivot Electric',
  'Miller Group', 'R.V. Anderson', 'Priestly Demolition',
  'Coco Paving', 'Lafarge Canada', 'Surespan', 'Hard Rock',
  'Dufferin Concrete', 'Smith Brothers & Wilson'
];

const PROV_MAP = {
  'ontario': 'ON', 'british columbia': 'BC', 'alberta': 'AB', 'quebec': 'QC',
  'manitoba': 'MB', 'saskatchewan': 'SK', 'nova scotia': 'NS',
  'new brunswick': 'NB', 'newfoundland': 'NL', 'prince edward island': 'PE',
  'northwest territories': 'NT', 'nunavut': 'NU', 'yukon': 'YT',
  'toronto': 'ON', 'vancouver': 'BC', 'calgary': 'AB', 'edmonton': 'AB',
  'montreal': 'QC', 'ottawa': 'ON', 'winnipeg': 'MB', 'hamilton': 'ON',
  'kitchener': 'ON', 'london': 'ON', 'mississauga': 'ON', 'brampton': 'ON',
  'markham': 'ON', 'vaughan': 'ON', 'surrey': 'BC', 'burnaby': 'BC',
  'richmond': 'BC', 'kelowna': 'BC', 'victoria': 'BC', 'saskatoon': 'SK',
  'regina': 'SK', 'halifax': 'NS', 'moncton': 'NB', 'fredericton': 'NB',
  'thunder bay': 'ON', 'sudbury': 'ON', 'kingston': 'ON', 'windsor': 'ON',
  'barrie': 'ON', 'guelph': 'ON', 'oshawa': 'ON', 'cambridge': 'ON', 'waterloo': 'ON',
};

function guessProvince(locationStr) {
  if (!locationStr) return null;
  const lower = locationStr.toLowerCase();
  for (const [key, abbr] of Object.entries(PROV_MAP)) {
    if (lower.includes(key)) return abbr;
  }
  return null;
}

function adzunaGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ConsTradeHire/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Adzuna')); }
      });
    }).on('error', reject);
  });
}

async function fetchCompanyJobs(companyName) {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_API_KEY;
  if (!appId || !appKey) return [];

  const url = `https://api.adzuna.com/v1/api/jobs/ca/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&company=${encodeURIComponent(companyName)}&where=Canada&content-type=application/json`;
  try {
    const data = await adzunaGet(url);
    return (data.results || []).map(j => ({
      title:       j.title         || '',
      description: j.description  || j.title || '',
      location:    j.location?.display_name || 'Canada',
      salary:      j.salary_min ? `$${Math.round(j.salary_min/1000)}k–$${Math.round((j.salary_max||j.salary_min)/1000)}k` : null,
      jobType:     j.contract_time || 'Full-time',
      externalUrl: j.redirect_url || null,
      externalId:  j.id ? String(j.id) : null,
      companyName,
      postedAt:    j.created ? new Date(j.created) : new Date(),
    })).filter(j => j.title && j.externalUrl);
  } catch (e) {
    console.warn(`[companyScraper] Adzuna failed for "${companyName}":`, e.message);
    return [];
  }
}

// Main scrape function — returns summary object
async function scrapeAllCompanies() {
  const results = { added: 0, skipped: 0, errors: [], companies: [] };

  for (const company of SCRAPE_COMPANIES) {
    try {
      const jobs = await fetchCompanyJobs(company);
      let added = 0;

      for (const j of jobs) {
        if (!j.externalUrl) continue;
        const exists = await prisma.job.findFirst({ where: { externalUrl: j.externalUrl }, select: { id: true } });
        if (exists) { results.skipped++; continue; }

        const fullDesc = await fetchFullDescription(j.externalUrl, j.description);
        const province = guessProvince(j.location);

        await prisma.job.create({
          data: {
            title:       j.title.trim(),
            description: (fullDesc || j.description).trim(),
            location:    j.location,
            city:        j.location.split(',')[0]?.trim() || null,
            province,
            salary:      j.salary,
            jobType:     j.jobType,
            skills:      [],
            source:      'API',
            externalUrl: j.externalUrl,
            externalId:  j.externalId,
            companyName: j.companyName,
            postedAt:    j.postedAt,
            expiresAt:   new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
            isActive:    true,
          }
        });
        added++;
        results.added++;
      }

      results.companies.push({ company, found: jobs.length, added });
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      results.errors.push({ company, error: e.message });
    }
  }

  await closeBrowser().catch(() => {});
  return results;
}

module.exports = { scrapeAllCompanies, SCRAPE_COMPANIES };
