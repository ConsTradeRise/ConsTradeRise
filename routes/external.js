// ─────────────────────────────────────────────
//  ConsTradeHire — APILayer Integrations
//  All API keys stay server-side — never exposed to client
//
//  GET  /api/geo           → IPstack (auto-detect user location)
//  POST /api/validate/email → Mailboxlayer (email validation)
//  POST /api/validate/phone → Numverify (Canadian phone validation)
//  GET  /api/news          → Mediastack (construction news, cached 1h)
// ─────────────────────────────────────────────

'use strict';
const express = require('express');
const https   = require('https');
const http    = require('http');

const router = express.Router();

// Simple HTTP/HTTPS GET helper
function apiGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from external API')); }
      });
    }).on('error', reject);
  });
}

// ─── NEWS CACHE (1 hour) ─────────────────────
let newsCache = { data: null, at: 0 };

// ─── GEO — detect province from IP ───────────
// GET /api/geo
router.get('/geo', async (req, res) => {
  const key = process.env.IPSTACK_API_KEY;
  if (!key) return res.json({ province: '', city: '', country: '' });

  try {
    // X-Forwarded-For from Vercel, fallback to remoteAddress
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0].trim().replace('::ffff:', '');

    // Skip loopback IPs (local dev)
    if (!ip || ip === '127.0.0.1' || ip === '::1') {
      return res.json({ province: 'Ontario', city: '', country: 'CA' });
    }

    const data = await apiGet(`http://api.ipstack.com/${ip}?access_key=${key}&fields=country_code,region_name,city`);

    res.json({
      country:  data.country_code || '',
      province: data.region_name  || '',
      city:     data.city         || ''
    });
  } catch (e) {
    console.warn('[geo] IPstack error:', e.message);
    res.json({ province: '', city: '', country: '' });
  }
});

// ─── EMAIL VALIDATION ─────────────────────────
// POST /api/validate/email  { email }
router.post('/validate/email', async (req, res) => {
  const key   = process.env.MAILBOXLAYER_API_KEY;
  const email = (req.body.email || '').trim().toLowerCase().substring(0, 254);

  if (!email) return res.status(400).json({ error: 'email required' });

  // Basic format check without API (always run)
  const fmt = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!fmt) return res.json({ valid: false, reason: 'Invalid email format' });

  if (!key) return res.json({ valid: true, reason: 'format_ok' }); // no key = skip deep check

  try {
    const data = await apiGet(
      `http://apilayer.net/api/check?access_key=${key}&email=${encodeURIComponent(email)}&smtp=1&format=1`
    );

    if (data.error) {
      console.warn('[email-validate] API error:', data.error.info);
      return res.json({ valid: fmt, reason: 'format_check_only' });
    }

    res.json({
      valid:        data.format_valid && !data.disposable,
      formatValid:  data.format_valid,
      disposable:   data.disposable,
      smtpValid:    data.smtp_check,
      reason:       data.disposable ? 'Disposable email addresses are not allowed'
                  : !data.format_valid ? 'Invalid email format'
                  : 'ok'
    });
  } catch (e) {
    console.warn('[email-validate] Error:', e.message);
    res.json({ valid: fmt, reason: 'format_check_only' });
  }
});

// ─── PHONE VALIDATION ─────────────────────────
// POST /api/validate/phone  { phone }
router.post('/validate/phone', async (req, res) => {
  const key   = process.env.NUMVERIFY_API_KEY;
  const phone = (req.body.phone || '').replace(/\D/g, '').substring(0, 15);

  if (!phone) return res.status(400).json({ error: 'phone required' });

  if (!key) return res.json({ valid: phone.length >= 10, reason: 'length_check_only' });

  try {
    const data = await apiGet(
      `http://apilayer.net/api/validate?access_key=${key}&number=${phone}&country_code=CA&format=1`
    );

    if (data.error) {
      console.warn('[phone-validate] API error:', data.error.info);
      return res.json({ valid: phone.length >= 10, reason: 'length_check_only' });
    }

    res.json({
      valid:         data.valid,
      localFormat:   data.local_format,
      intlFormat:    data.international_format,
      countryCode:   data.country_code,
      lineType:      data.line_type,
      reason:        data.valid ? 'ok' : 'Invalid Canadian phone number'
    });
  } catch (e) {
    console.warn('[phone-validate] Error:', e.message);
    res.json({ valid: phone.length >= 10, reason: 'length_check_only' });
  }
});

// ─── CONSTRUCTION NEWS (cached 1h) ────────────
// GET /api/news
router.get('/news', async (req, res) => {
  const key = process.env.MEDIASTACK_API_KEY;

  // Serve cache if fresh (1 hour)
  if (newsCache.data && Date.now() - newsCache.at < 60 * 60 * 1000) {
    return res.json(newsCache.data);
  }

  if (!key) return res.json({ articles: [] });

  try {
    const data = await apiGet(
      `http://api.mediastack.com/v1/news?access_key=${key}&keywords=construction,trades,building&countries=ca&languages=en&limit=6&sort=published_desc`
    );

    const articles = (data.data || []).map(a => ({
      title:       a.title,
      description: a.description ? a.description.substring(0, 160) : '',
      url:         a.url,
      source:      a.source,
      publishedAt: a.published_at,
      image:       a.image
    })).filter(a => a.title && a.url);

    newsCache = { data: { articles }, at: Date.now() };
    res.json({ articles });
  } catch (e) {
    console.warn('[news] Mediastack error:', e.message);
    res.json({ articles: newsCache.data?.articles || [] });
  }
});

module.exports = router;
