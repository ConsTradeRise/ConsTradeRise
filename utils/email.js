'use strict';
// ─────────────────────────────────────────────
//  ConsTradeHire — Email Utility
//
//  Priority order:
//    1. Resend API (RESEND_API_KEY) — no Gmail needed, free tier 3k/mo
//    2. Gmail SMTP (EMAIL_USER + EMAIL_PASS)
//
//  To use Resend:
//    1. Sign up free at https://resend.com
//    2. Add RESEND_API_KEY=re_... to Vercel env vars
//    3. Verify your domain OR use "onboarding@resend.dev" for testing
//
//  To use Gmail:
//    1. Enable 2FA on Gmail, create App Password at myaccount.google.com
//    2. Set EMAIL_USER=you@gmail.com  EMAIL_PASS=xxxx-xxxx-xxxx-xxxx
//
//  All functions fail silently if no provider is configured.
// ─────────────────────────────────────────────

const https    = require('https');
const nodemailer = require('nodemailer');

// ─── Send via Resend REST API (no SDK needed) ─
function sendViaResend(to, subject, html) {
  const apiKey  = process.env.RESEND_API_KEY;
  const from    = process.env.EMAIL_FROM || 'ConsTradeHire <onboarding@resend.dev>';

  return new Promise((resolve) => {
    const body = JSON.stringify({ from, to, subject, html });
    const req  = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          console.error('[email/resend] Error', res.statusCode, d.slice(0, 200));
        }
        resolve();
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.on('error', (e) => { console.error('[email/resend]', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── Send via Gmail SMTP (nodemailer) ─────────
async function sendViaGmail(to, subject, html) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const from = process.env.EMAIL_FROM || `ConsTradeHire <${user}>`;

  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transport.sendMail({ from, to, subject, html });
}

// ─── Unified send ─────────────────────────────
async function sendEmail({ to, subject, html }) {
  try {
    if (process.env.RESEND_API_KEY) {
      await sendViaResend(to, subject, html);
    } else if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await sendViaGmail(to, subject, html);
    } else {
      console.warn('[email] No provider configured. Set RESEND_API_KEY or EMAIL_USER+EMAIL_PASS in env vars.');
    }
  } catch (e) {
    console.error('[email] Failed to send to', to, '—', e.message);
  }
}

// ─── Email templates ──────────────────────────

function baseTemplate(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
  .card { background: #fff; border-radius: 8px; padding: 32px; max-width: 560px; margin: 0 auto; }
  .logo { font-size: 22px; font-weight: bold; color: #f97316; margin-bottom: 24px; }
  h2 { color: #1e293b; margin-top: 0; }
  .btn { display: inline-block; background: #f97316; color: #fff; padding: 12px 24px;
         border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 16px; }
  .job-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; margin: 10px 0; }
  .job-title { font-weight: bold; color: #1e293b; font-size: 16px; }
  .job-meta { color: #64748b; font-size: 13px; margin-top: 4px; }
  .footer { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 24px; }
</style></head>
<body><div class="card">
  <div class="logo">ConsTradeHire</div>
  <h2>${title}</h2>
  ${bodyHtml}
  <div class="footer">
    ConsTradeHire · Construction Jobs Canada<br>
    <a href="https://constradehire.com">constradehire.com</a>
  </div>
</div></body></html>`;
}

// New message notification
async function sendNewMessageAlert({ to, receiverName, senderName, preview }) {
  const html = baseTemplate('You have a new message', `
    <p>Hi ${receiverName},</p>
    <p><strong>${senderName}</strong> sent you a message on ConsTradeHire:</p>
    <blockquote style="border-left:3px solid #f97316;padding-left:12px;color:#475569;">
      "${preview}"
    </blockquote>
    <a class="btn" href="https://constradehire.com/messages.html">Reply Now</a>
  `);
  await sendEmail({ to, subject: `New message from ${senderName} — ConsTradeHire`, html });
}

// Application status update (to worker)
async function sendApplicationUpdate({ to, workerName, jobTitle, company, status }) {
  const statusLabel = {
    VIEWED:      'Your application has been viewed',
    SHORTLISTED: 'You\'ve been shortlisted!',
    REJECTED:    'Application status updated'
  }[status] || 'Application status updated';

  const statusMsg = {
    VIEWED:      `The employer at <strong>${company}</strong> has viewed your application for <strong>${jobTitle}</strong>.`,
    SHORTLISTED: `Great news! You've been shortlisted for <strong>${jobTitle}</strong> at <strong>${company}</strong>. Expect to hear from them soon.`,
    REJECTED:    `Your application for <strong>${jobTitle}</strong> at <strong>${company}</strong> was not selected at this time. Keep applying — the right opportunity is out there.`
  }[status] || `Your application for <strong>${jobTitle}</strong> has been updated.`;

  const html = baseTemplate(statusLabel, `
    <p>Hi ${workerName},</p>
    <p>${statusMsg}</p>
    <a class="btn" href="https://constradehire.com/dashboard.html">View My Applications</a>
  `);
  await sendEmail({ to, subject: `${statusLabel} — ConsTradeHire`, html });
}

// New application alert (to employer)
async function sendNewApplicationAlert({ to, employerName, workerName, jobTitle }) {
  const html = baseTemplate('New Application Received', `
    <p>Hi ${employerName},</p>
    <p><strong>${workerName}</strong> has applied for your job posting: <strong>${jobTitle}</strong>.</p>
    <a class="btn" href="https://constradehire.com/dashboard.html">Review Application</a>
  `);
  await sendEmail({ to, subject: `New applicant for "${jobTitle}" — ConsTradeHire`, html });
}

// Daily job digest (to worker)
async function sendJobDigest({ to, workerName, jobs }) {
  if (!jobs || jobs.length === 0) return;

  const jobCards = jobs.map(j => `
    <div class="job-card">
      <div class="job-title">${j.title}</div>
      <div class="job-meta">
        ${j.companyName || 'Company'} · ${j.location || 'Canada'}
        ${j.salary ? ' · ' + j.salary : ''}
      </div>
      ${j.externalUrl || j.id
        ? `<a href="${j.externalUrl || 'https://constradehire.com/jobs.html'}" style="font-size:13px;color:#f97316;">View Job →</a>`
        : ''}
    </div>
  `).join('');

  const html = baseTemplate(`${jobs.length} New Construction Jobs For You`, `
    <p>Hi ${workerName},</p>
    <p>Here are the latest construction jobs posted in the last 24 hours:</p>
    ${jobCards}
    <a class="btn" href="https://constradehire.com/jobs.html">Browse All Jobs</a>
    <p style="font-size:12px;color:#94a3b8;margin-top:16px;">
      To stop receiving job alerts, update your preferences in your
      <a href="https://constradehire.com/dashboard.html">profile settings</a>.
    </p>
  `);
  await sendEmail({ to, subject: `${jobs.length} new construction jobs in Canada — ConsTradeHire`, html });
}

module.exports = {
  sendEmail,
  baseTemplate,
  sendNewMessageAlert,
  sendApplicationUpdate,
  sendNewApplicationAlert,
  sendJobDigest
};
