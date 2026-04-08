// Edge Function: send-email
// Internal use only — called by other edge functions or server-side triggers
// Protected by CRON_SECRET or service role

import { corsHeaders, json, err } from '../_shared/supabase.ts';

function baseTemplate(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px}
  .card{background:#fff;border-radius:8px;padding:32px;max-width:560px;margin:0 auto}
  .logo{font-size:22px;font-weight:bold;color:#f97316;margin-bottom:24px}
  h2{color:#1e293b;margin-top:0}
  .btn{display:inline-block;background:#f97316;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:16px}
  .job-card{border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin:10px 0}
  .job-title{font-weight:bold;color:#1e293b;font-size:16px}
  .job-meta{color:#64748b;font-size:13px;margin-top:4px}
  .footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px}
</style></head>
<body><div class="card">
  <div class="logo">ConsTradeHire</div>
  <h2>${title}</h2>
  ${bodyHtml}
  <div class="footer">ConsTradeHire · Construction Jobs Canada<br>
    <a href="https://constradehire.com">constradehire.com</a></div>
</div></body></html>`;
}

function buildHtml(type: string, data: Record<string, unknown>): { subject: string; html: string } {
  switch (type) {
    case 'verify': return {
      subject: 'Verify your ConsTradeHire email',
      html: baseTemplate('Verify Your Email Address', `
        <p>Hi ${data.name},</p>
        <p>Click the button below to verify your email address.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${data.url}" class="btn">Verify My Email →</a>
        </p>
        <p style="font-size:12px;color:#94a3b8;">Link expires in 24 hours.<br>
          <a href="${data.url}" style="color:#f97316;word-break:break-all;">${data.url}</a>
        </p>`)
    };
    case 'reset': return {
      subject: 'Reset your ConsTradeHire password',
      html: baseTemplate('Password Reset Request', `
        <p>Hi ${data.name},</p>
        <p>Click below to reset your password. Expires in 1 hour.</p>
        <a href="${data.url}" class="btn">Reset Password</a>
        <p style="font-size:12px;color:#94a3b8;margin-top:20px;">
          If you didn't request this, ignore this email.</p>`)
    };
    case 'new-application': return {
      subject: `New applicant for "${data.jobTitle}" — ConsTradeHire`,
      html: baseTemplate('New Application Received', `
        <p>Hi ${data.employerName},</p>
        <p><strong>${data.workerName}</strong> applied for: <strong>${data.jobTitle}</strong></p>
        <a href="https://constradehire.com/employer.html" class="btn">Review Application</a>`)
    };
    case 'application-update': {
      const labels: Record<string, string> = {
        VIEWED:      'Your application has been viewed',
        SHORTLISTED: "You've been shortlisted!",
        REJECTED:    'Application status updated'
      };
      const msgs: Record<string, string> = {
        VIEWED:      `The employer has viewed your application for <strong>${data.jobTitle}</strong>.`,
        SHORTLISTED: `You've been shortlisted for <strong>${data.jobTitle}</strong> at <strong>${data.company}</strong>!`,
        REJECTED:    `Your application for <strong>${data.jobTitle}</strong> was not selected at this time.`
      };
      const status = String(data.status || '');
      return {
        subject: `${labels[status] || 'Application update'} — ConsTradeHire`,
        html: baseTemplate(labels[status] || 'Application Update', `
          <p>Hi ${data.workerName},</p>
          <p>${msgs[status] || 'Your application status has been updated.'}</p>
          <a href="https://constradehire.com/dashboard.html" class="btn">View My Applications</a>`)
      };
    }
    case 'new-message': return {
      subject: `New message from ${data.senderName} — ConsTradeHire`,
      html: baseTemplate('You have a new message', `
        <p>Hi ${data.receiverName},</p>
        <p><strong>${data.senderName}</strong> sent you a message:</p>
        <blockquote style="border-left:3px solid #f97316;padding-left:12px;color:#475569;">
          "${data.preview}"</blockquote>
        <a href="https://constradehire.com/messages.html" class="btn">Reply Now</a>`)
    };
    case 'job-digest': {
      const jobs = data.jobs as Array<Record<string, unknown>>;
      const cards = jobs.map(j => `
        <div class="job-card">
          <div class="job-title">${j.title}</div>
          <div class="job-meta">${j.companyName || 'Company'} · ${j.location || 'Canada'}${j.salary ? ' · ' + j.salary : ''}</div>
          ${j.externalUrl ? `<a href="${j.externalUrl}" style="font-size:13px;color:#f97316;">View Job →</a>` : ''}
        </div>`).join('');
      return {
        subject: `${jobs.length} new construction jobs in Canada — ConsTradeHire`,
        html: baseTemplate(`${jobs.length} New Construction Jobs For You`, `
          <p>Hi ${data.workerName},</p>
          <p>Latest construction jobs posted in the last 24 hours:</p>
          ${cards}
          <a href="https://constradehire.com/jobs.html" class="btn">Browse All Jobs</a>
          <p style="font-size:12px;color:#94a3b8;margin-top:16px;">
            Manage alerts in your <a href="https://constradehire.com/dashboard.html" style="color:#f97316;">profile settings</a>.</p>`)
      };
    }
    default:
      return { subject: data.subject as string || 'ConsTradeHire', html: String(data.html || '') };
  }
}

async function sendViaSmtp(to: string, subject: string, html: string) {
  // Resend API (preferred)
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from:    Deno.env.get('EMAIL_FROM') || 'ConsTradeHire <noreply@constradehire.com>',
        to:      [to],
        subject,
        html
      })
    });
    if (!res.ok) throw new Error(`Resend error: ${await res.text()}`);
    return;
  }
  throw new Error('No email provider configured. Set RESEND_API_KEY.');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405, origin);

  // Secure: only callable from service role or with cron key
  const cronKey   = req.headers.get('x-cron-key');
  const validKey  = Deno.env.get('CRON_SECRET');
  const authHeader = req.headers.get('authorization') || '';
  const isService  = authHeader.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '__none__');

  if (validKey && cronKey !== validKey && !isService) {
    return err('Unauthorized', 401, origin);
  }

  const { to, type, data } = await req.json();
  if (!to || !type) return err('to and type required', 400, origin);

  try {
    const { subject, html } = buildHtml(type, data || {});
    await sendViaSmtp(String(to), subject, html);
    return json({ ok: true }, 200, origin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[send-email]', msg);
    return err(msg, 500, origin);
  }
});
