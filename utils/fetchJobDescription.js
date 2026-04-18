'use strict';
// Fetches the full job description from a job URL using Puppeteer.
// Falls back to the snippet if the page cannot be scraped.

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  const puppeteer = require('puppeteer');
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });
  return _browser;
}

// Selectors tried in order — covers major ATS systems and job boards
const DESC_SELECTORS = [
  '[data-automation-id="jobPostingDescription"]', // Workday
  '#content .job__description',                   // Greenhouse
  '.posting-content .section-wrapper',            // Lever
  '.iCIMS_JobContent',                            // iCIMS
  '#descriptionH',                                // Taleo
  '[data-testid="jobDescriptionText"]',           // Indeed
  '#jobDescriptionText',                          // Indeed alt
  '.adp-body',                                    // Adzuna job page
  '[class*="job-description"]',
  '[class*="jobDescription"]',
  '[class*="description"]',
  'article',
  'main',
];

async function fetchFullDescription(url, fallback) {
  if (fallback === undefined) fallback = '';
  if (!url) return fallback;

  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // Block images/fonts/stylesheets to speed up load
    await page.setRequestInterception(true);
    page.on('request', function(req) {
      const type = req.resourceType();
      if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Try each selector in order
    for (let i = 0; i < DESC_SELECTORS.length; i++) {
      const sel = DESC_SELECTORS[i];
      try {
        const text = await page.$eval(sel, function(el) { return el.innerText ? el.innerText.trim() : ''; });
        if (text && text.length > 100) return text;
      } catch (_) {}
    }

    // Last resort: grab visible body text after removing chrome elements
    const bodyText = await page.evaluate(function() {
      var remove = document.querySelectorAll('nav, header, footer, script, style');
      for (var i = 0; i < remove.length; i++) remove[i].remove();
      return document.body ? (document.body.innerText || '').trim() : '';
    });

    return bodyText.length > 200 ? bodyText.substring(0, 8000) : fallback;
  } catch (e) {
    console.warn('[fetchJobDesc] Failed for', url.slice(0, 60), '—', e.message);
    return fallback;
  } finally {
    if (page) await page.close().catch(function() {});
  }
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(function() {});
    _browser = null;
  }
}

module.exports = { fetchFullDescription, closeBrowser };
