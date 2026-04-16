// ─────────────────────────────────────────────
//  ConsTradeHire — Frontend App
//  Auth helpers, API calls, UI utilities
// ─────────────────────────────────────────────

'use strict';

const API = '';  // same-origin — empty base URL

// ─── AUTH HELPERS ─────────────────────────────
const Auth = {
  getToken()  { return localStorage.getItem('tu_token'); },
  getUser()   { try { return JSON.parse(localStorage.getItem('tu_user')); } catch { return null; } },
  isLoggedIn(){ return !!this.getToken(); },
  getRole()   { return this.getUser()?.role || null; },

  save(token, user) {
    localStorage.setItem('tu_token', token);
    localStorage.setItem('tu_user', JSON.stringify(user));
  },

  clear() {
    localStorage.removeItem('tu_token');
    localStorage.removeItem('tu_user');
  },

  redirectIfNotAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
      return true;
    }
    return false;
  },

  redirectToDashboard() {
    const role = this.getRole();
    if (role === 'EMPLOYER') window.location.href = '/employer.html';
    else if (role === 'ADMIN') window.location.href = '/admin.html';
    else {
      // New workers go through onboarding if they haven't completed it
      const onboarded = localStorage.getItem('ctr_onboarded');
      if (!onboarded) window.location.href = '/onboarding.html';
      else window.location.href = '/dashboard.html';
    }
  }
};

// ─── API HELPER ───────────────────────────────
async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  try {
    const res = await fetch(API + path, opts);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Network error — please check your connection' } };
  }
}

// ─── TOAST NOTIFICATIONS ─────────────────────
const Toast = {
  container: null,

  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  show(message, type = 'default', duration = 3500) {
    this.init();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', default: 'ℹ' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${message}</span>`;
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity .3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg)   { this.show(msg, 'error'); },
  warn(msg)    { this.show(msg, 'default'); },
  info(msg)    { this.show(msg, 'default'); }
};

// ─── NAVBAR INIT ──────────────────────────────
function initNavbar() {
  const loginBtn    = document.getElementById('navLoginBtn');
  const registerBtn = document.getElementById('navRegisterBtn');
  const dashLink    = document.getElementById('navDashboardLink');
  const logoutBtn   = document.getElementById('navLogoutBtn');
  const toggle      = document.getElementById('navToggle');
  const links       = document.getElementById('navLinks');

  if (Auth.isLoggedIn()) {
    const user = Auth.getUser();
    if (loginBtn)    loginBtn.style.display    = 'none';
    if (registerBtn) registerBtn.style.display = 'none';
    if (dashLink) {
      dashLink.style.display = 'inline-flex';
      dashLink.textContent   = user?.name?.split(' ')[0] || 'Dashboard';
      dashLink.href = Auth.getRole() === 'EMPLOYER' ? '/employer.html' : '/dashboard.html';
    }
    if (logoutBtn) {
      logoutBtn.style.display = 'inline-flex';
      logoutBtn.addEventListener('click', () => {
        Auth.clear();
        window.location.href = '/';
      });
    }

    // Notification bell
    injectNotificationBell(links);
  }

  // Mobile nav toggle
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
  }
}

function injectNotificationBell(links) {
  if (!links) return;
  if (document.getElementById('notifBtn')) return;
  const bell = document.createElement('div');
  bell.style.cssText = 'position:relative;display:inline-flex;align-items:center;cursor:pointer;';
  bell.innerHTML = `
    <button id="notifBtn" style="background:none;border:none;cursor:pointer;font-size:18px;padding:6px 8px;border-radius:8px;transition:background .15s;" title="Notifications">🔔
      <span id="notifCount" style="display:none;position:absolute;top:2px;right:2px;background:#dc2626;color:#fff;border-radius:100px;font-size:10px;font-weight:700;padding:1px 5px;min-width:16px;text-align:center;"></span>
    </button>
    <div id="notifDropdown" style="display:none;position:absolute;top:42px;right:0;width:320px;background:#fff;border:1px solid var(--gray-200);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);z-index:500;max-height:400px;overflow-y:auto;">
      <div style="padding:12px 16px;border-bottom:1px solid var(--gray-200);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;font-size:14px;">Notifications</span>
        <button onclick="markAllRead()" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--blue);">Mark all read</button>
      </div>
      <div id="notifList"><div style="padding:20px;text-align:center;color:var(--gray-400);font-size:13px;">Loading...</div></div>
    </div>`;
  links.insertBefore(bell, links.firstChild);

  document.getElementById('notifBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('notifDropdown');
    const isOpen = dd.style.display !== 'none';
    dd.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) loadNotifications();
  });
  document.addEventListener('click', () => {
    const dd = document.getElementById('notifDropdown');
    if (dd) dd.style.display = 'none';
  });

  fetchNotifCount();
  setInterval(fetchNotifCount, 30000);
}

async function fetchNotifCount() {
  if (!Auth.isLoggedIn()) return;
  const { ok, data } = await apiCall('GET', '/api/notifications');
  if (!ok) return;
  const el = document.getElementById('notifCount');
  if (el && data.unread > 0) { el.textContent = data.unread; el.style.display = 'inline'; }
  else if (el) el.style.display = 'none';
}

async function loadNotifications() {
  const { ok, data } = await apiCall('GET', '/api/notifications');
  const el = document.getElementById('notifList');
  if (!el) return;
  if (!ok || !data.notifications?.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--gray-400);font-size:13px;">No notifications yet.</div>`;
    return;
  }
  const notifEls = data.notifications.map(n => {
    // Strict allowlist of valid notification link prefixes — prevents XSS via href injection
    const ALLOWED_LINK_PREFIXES = ['/dashboard', '/employer', '/jobs', '/messages', '/profile', '/onboarding'];
    const safeLink = n.link && ALLOWED_LINK_PREFIXES.some(p => n.link.startsWith(p)) ? n.link : '';
    const div = document.createElement('div');
    div.style.cssText = `padding:12px 16px;border-bottom:1px solid var(--gray-100);cursor:${safeLink?'pointer':'default'};background:${n.read?'#fff':'var(--blue-light)'}`;
    if (safeLink) div.addEventListener('click', () => { window.location.href = safeLink; });
    div.innerHTML = `
      <div style="font-size:13px;font-weight:${n.read?'400':'700'};color:var(--gray-900);">${escapeHtml(n.title)}</div>
      <div style="font-size:12px;color:var(--gray-500);margin-top:2px;">${escapeHtml(n.body)}</div>
      <div style="font-size:11px;color:var(--gray-400);margin-top:4px;">${formatDate(n.createdAt)}</div>`;
    return div;
  });
  el.innerHTML = '';
  notifEls.forEach(d => el.appendChild(d));
  fetchNotifCount();
}

async function markAllRead() {
  await apiCall('PUT', '/api/notifications/read-all');
  loadNotifications();
  const el = document.getElementById('notifCount');
  if (el) el.style.display = 'none';
}

// ── Shared OTP step state ──────────────────────
let _otpEmail    = '';
let _otpPurpose  = '';
let _otpOnOk     = null;
let _otpOnCancel = null;
let _otpTimerIv  = null;
let _otpResendIv = null;

function showOtpPanel(email, masked, purpose, onOk, onCancel) {
  _otpEmail    = email;
  _otpPurpose  = purpose;
  _otpOnOk     = onOk;
  _otpOnCancel = onCancel || null;

  const panel = document.getElementById('otpPanel');
  if (!panel) return;
  panel.style.display = 'block';

  const maskedEl = document.getElementById('otpMaskedEmail');
  if (maskedEl) maskedEl.textContent = masked || email;

  const errEl = document.getElementById('otpError');
  if (errEl) errEl.classList.add('hidden');

  const input     = document.getElementById('otpInput');
  const submitBtn = document.getElementById('otpSubmitBtn');
  if (input) {
    input.value = '';
    input.disabled = false;
    input.focus();
    // Strip non-digits and auto-submit at 6 chars
    input.oninput = () => {
      input.value = input.value.replace(/\D/g,'').slice(0,6);
      if (input.value.length === 6) submitOtpStep();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') submitOtpStep(); };
  }
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Verify Code'; }

  _otpStartTimer(10 * 60);
  _otpStartResendCooldown(60);
}

function _otpStartTimer(seconds) {
  clearInterval(_otpTimerIv);
  let rem = seconds;
  const el = document.getElementById('otpTimer');
  const update = () => {
    if (!el) return;
    if (rem <= 0) {
      clearInterval(_otpTimerIv);
      el.textContent = 'Code expired — request a new one below.';
      el.style.color = '#ef4444';
      const inp = document.getElementById('otpInput');
      const btn = document.getElementById('otpSubmitBtn');
      if (inp) inp.disabled = true;
      if (btn) btn.disabled = true;
      return;
    }
    const m = String(Math.floor(rem/60)).padStart(2,'0');
    const s = String(rem%60).padStart(2,'0');
    el.textContent = `Expires in ${m}:${s}`;
    el.style.color = rem < 60 ? '#ef4444' : '';
    rem--;
  };
  update();
  _otpTimerIv = setInterval(update, 1000);
}

function _otpStartResendCooldown(seconds) {
  clearInterval(_otpResendIv);
  let rem = seconds;
  const btn = document.getElementById('otpResendBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.style.cssText = 'font-size:13px;color:var(--gray-400);cursor:not-allowed;background:none;border:none;font-weight:600;padding:4px;';
  const update = () => {
    if (rem <= 0) {
      clearInterval(_otpResendIv);
      btn.disabled = false;
      btn.style.cssText = 'font-size:13px;color:var(--blue);cursor:pointer;background:none;border:none;font-weight:600;padding:4px;';
      btn.textContent = 'Resend code';
      return;
    }
    btn.textContent = `Resend code (${rem}s)`;
    rem--;
  };
  update();
  _otpResendIv = setInterval(update, 1000);
}

async function submitOtpStep() {
  const input  = document.getElementById('otpInput');
  const errEl  = document.getElementById('otpError');
  const btn    = document.getElementById('otpSubmitBtn');
  const otp    = input ? input.value.trim() : '';

  if (!otp || otp.length !== 6) {
    if (errEl) { errEl.textContent = 'Please enter the 6-digit code'; errEl.classList.remove('hidden'); }
    return;
  }
  if (errEl) errEl.classList.add('hidden');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
  if (input) input.disabled = true;

  const endpoint = _otpPurpose === 'LOGIN'
    ? '/api/auth/verify-login-otp'
    : '/api/auth/verify-email-otp';

  const { ok, data } = await apiCall('POST', endpoint, { email: _otpEmail, otp });

  if (ok) {
    clearInterval(_otpTimerIv);
    clearInterval(_otpResendIv);
    if (data.token) Auth.save(data.token, data.user);
    if (_otpOnOk) _otpOnOk(data);
  } else {
    if (errEl) { errEl.textContent = data.error || 'Invalid code — try again'; errEl.classList.remove('hidden'); }
    if (btn)   { btn.disabled = false; btn.textContent = 'Verify Code'; }
    if (input) { input.disabled = false; input.value = ''; input.focus(); }
  }
}

async function resendOtpStep() {
  const btn   = document.getElementById('otpResendBtn');
  const errEl = document.getElementById('otpError');
  if (btn) btn.disabled = true;

  const { ok, data } = await apiCall('POST', '/api/auth/resend-otp', { email: _otpEmail, purpose: _otpPurpose });

  if (ok) {
    if (errEl) errEl.classList.add('hidden');
    Toast.success('New code sent — check your email.');
    const inp = document.getElementById('otpInput');
    const sub = document.getElementById('otpSubmitBtn');
    if (inp) { inp.disabled = false; inp.value = ''; inp.focus(); }
    if (sub) sub.disabled = false;
    _otpStartTimer(10 * 60);
    _otpStartResendCooldown(60);
  } else {
    if (errEl) { errEl.textContent = data.error || 'Failed to resend. Try again.'; errEl.classList.remove('hidden'); }
    if (btn) btn.disabled = false;
  }
}

function cancelOtpStep() {
  clearInterval(_otpTimerIv);
  clearInterval(_otpResendIv);
  const panel = document.getElementById('otpPanel');
  if (panel) panel.style.display = 'none';
  if (_otpOnCancel) _otpOnCancel();
}

// ─── REGISTER PAGE ────────────────────────────
function initRegisterPage() {
  const form = document.getElementById('registerForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn     = document.getElementById('regBtn');
    const errorEl = document.getElementById('registerError');

    const role     = document.getElementById('regRole')?.value || 'WORKER';
    const name     = document.getElementById('regName').value.trim();
    const email    = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const company  = document.getElementById('regCompany')?.value.trim() || '';

    if (!name || !email || !password) {
      if (errorEl) { errorEl.textContent = 'All fields are required'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (password.length < 8) {
      if (errorEl) { errorEl.textContent = 'Password must be at least 8 characters'; errorEl.classList.remove('hidden'); }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating account…';

    const payload = { name, email, password, role };
    if (role === 'EMPLOYER' && company) payload.company = company;

    const { ok, data } = await apiCall('POST', '/api/auth/register', payload);

    if (ok && data.requiresOtp) {
      // Hide form + benefits, show OTP panel
      form.style.display = 'none';
      const benefitsEl = document.getElementById('benefitsStrip');
      const headerEl   = document.querySelector('.reg-card-header');
      if (benefitsEl) benefitsEl.style.display = 'none';
      if (headerEl)   headerEl.style.display   = 'none';
      if (errorEl)    errorEl.classList.add('hidden');

      showOtpPanel(data.email || email, data.masked, 'VERIFY_EMAIL', () => {
        Toast.success('Email verified! Welcome to ConsTradeHire.');
        setTimeout(() => Auth.redirectToDashboard(), 800);
      }, () => {
        // Back to form
        form.style.display = 'block';
        if (benefitsEl) benefitsEl.style.display = '';
        if (headerEl)   headerEl.style.display   = '';
        btn.disabled = false;
        const cfg = typeof ROLE_CONFIG !== 'undefined' && typeof selectedRole !== 'undefined'
          ? ROLE_CONFIG[selectedRole] : null;
        btn.textContent = cfg ? cfg.btnText : 'Create Account';
      });

    } else if (ok && data.token) {
      // Email not required (dev mode) — log in directly
      Auth.save(data.token, data.user);
      Toast.success('Account created! Welcome to ConsTradeHire.');
      setTimeout(() => Auth.redirectToDashboard(), 800);

    } else {
      if (errorEl) { errorEl.textContent = data.error || 'Registration failed'; errorEl.classList.remove('hidden'); }
      btn.disabled = false;
      const cfg = typeof ROLE_CONFIG !== 'undefined' && typeof selectedRole !== 'undefined'
        ? ROLE_CONFIG[selectedRole] : null;
      btn.textContent = cfg ? cfg.btnText : 'Create Account';
    }
  });
}

async function resendVerificationEmail(email) {
  // Legacy helper — now proxies through resend-otp
  const { ok, data } = await apiCall('POST', '/api/auth/resend-otp', { email, purpose: 'VERIFY_EMAIL' });
  Toast[ok ? 'success' : 'error'](data.message || data.error || 'Done');
}

// ─── LOGIN PAGE ───────────────────────────────
function initLoginPage() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  if (Auth.isLoggedIn()) { Auth.redirectToDashboard(); return; }

  const params         = new URLSearchParams(window.location.search);
  const verifiedBanner = document.getElementById('loginVerifiedBanner');
  const loginError     = document.getElementById('loginError');

  if (params.get('verified') === '1' && verifiedBanner) verifiedBanner.style.display = 'block';
  if (params.get('verifyError') && loginError) {
    loginError.textContent = params.get('verifyError') === 'expired'
      ? 'Verification link has expired. Please request a new one.'
      : 'Invalid verification link. Please try again.';
    loginError.classList.remove('hidden');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn     = form.querySelector('[type=submit]');
    const errorEl = document.getElementById('loginError');

    if (verifiedBanner) verifiedBanner.style.display = 'none';
    if (errorEl) errorEl.classList.add('hidden');

    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    btn.disabled = true;
    btn.textContent = 'Sending code…';

    const { ok, data } = await apiCall('POST', '/api/auth/login', { email, password });

    const restoreBtn = () => {
      btn.disabled = false;
      const cfg = typeof ROLE_CONFIG !== 'undefined' && typeof selectedRole !== 'undefined'
        ? ROLE_CONFIG[selectedRole] : null;
      btn.textContent = cfg ? cfg.btnText : 'Login';
    };

    if (ok && data.requiresOtp) {
      // Hide login form, show OTP panel
      form.style.display = 'none';
      const benefitsEl = document.getElementById('benefitsStrip');
      const headerEl   = document.querySelector('.login-card-header');
      if (benefitsEl) benefitsEl.style.display = 'none';
      if (headerEl)   headerEl.style.display   = 'none';

      showOtpPanel(data.email || email, data.masked, 'LOGIN', (result) => {
        Toast.success('Welcome back!');
        const next = new URLSearchParams(window.location.search).get('next');
        setTimeout(() => {
          if (next && next.startsWith('/')) window.location.href = next;
          else Auth.redirectToDashboard();
        }, 600);
      }, () => {
        form.style.display = 'block';
        if (benefitsEl) benefitsEl.style.display = '';
        if (headerEl)   headerEl.style.display   = '';
        restoreBtn();
      });

    } else if (!ok && data.requiresOtp) {
      // Unverified email — show OTP panel for email verification
      form.style.display = 'none';
      const benefitsEl = document.getElementById('benefitsStrip');
      const headerEl   = document.querySelector('.login-card-header');
      if (benefitsEl) benefitsEl.style.display = 'none';
      if (headerEl)   headerEl.style.display   = 'none';

      showOtpPanel(data.email || email, data.masked, 'VERIFY_EMAIL', () => {
        Toast.success('Email verified! Welcome to ConsTradeHire.');
        setTimeout(() => Auth.redirectToDashboard(), 800);
      }, () => {
        form.style.display = 'block';
        if (benefitsEl) benefitsEl.style.display = '';
        if (headerEl)   headerEl.style.display   = '';
        restoreBtn();
      });

    } else if (ok && data.token) {
      // Dev mode: no email configured, direct token returned
      Auth.save(data.token, data.user);
      Toast.success('Welcome back!');
      const next = new URLSearchParams(window.location.search).get('next');
      setTimeout(() => {
        if (next && next.startsWith('/')) window.location.href = next;
        else Auth.redirectToDashboard();
      }, 600);

    } else {
      if (errorEl) { errorEl.textContent = data.error || 'Login failed'; errorEl.classList.remove('hidden'); }
      restoreBtn();
    }
  });
}

// ─── JOBS PAGE ────────────────────────────────
function initJobsPage() {
  const container = document.getElementById('jobsList');
  if (!container) return;

  let currentPage = 1;
  const params    = new URLSearchParams(window.location.search);

  const searchInput = document.getElementById('jobSearch');
  const locationInput = document.getElementById('jobLocation');
  const typeSelect  = document.getElementById('jobType');

  if (searchInput && params.get('search')) searchInput.value = params.get('search');

  async function loadJobs(page = 1) {
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    const search   = searchInput?.value.trim() || '';
    const location = locationInput?.value.trim() || '';
    const type     = typeSelect?.value || '';

    const query = new URLSearchParams({ page, limit: 20 });
    if (search)   query.set('search', search);
    if (location) query.set('location', location);
    if (type)     query.set('type', type);

    const { ok, data } = await apiCall('GET', `/api/jobs?${query}`);

    if (!ok) {
      container.innerHTML = `<div class="empty-state"><p class="text-gray">${data.error || 'Failed to load jobs'}</p></div>`;
      return;
    }

    // Update stats on home page
    const statEl = document.getElementById('statJobs');
    if (statEl && data.pagination) statEl.textContent = data.pagination.total.toLocaleString() + '+';

    if (!data.jobs?.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h3>No jobs found</h3>
          <p>Try different keywords or location</p>
        </div>`;
      return;
    }

    container.innerHTML = data.jobs.map(job => renderJobCard(job)).join('');
    currentPage = page;
  }

  // Search handler
  const searchBtn = document.getElementById('searchBtn');
  if (searchBtn) searchBtn.addEventListener('click', () => loadJobs(1));
  if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadJobs(1); });

  loadJobs(1);
}

function renderJobCard(job, isSaved = false) {
  const score    = job.atsScore;
  const scoreHtml = score
    ? `<span class="ats-score-badge ${getScoreClass(score.score)}">${score.score}%</span>`
    : '';
  const saveId = `save-${job.id}`;

  return `
    <div class="job-card" id="jobcard-${job.id}">
      <div class="job-card-header" onclick="window.location.href='/job.html?id=${job.id}'" style="cursor:pointer;">
        <div>
          <div class="job-title">${escapeHtml(job.title)}</div>
          <div class="job-company">${escapeHtml(job.companyName || job.employer?.profile?.companyName || job.employer?.name || 'Company')}</div>
        </div>
        ${scoreHtml}
      </div>
      <div class="job-meta">
        <span class="job-tag">📍 ${escapeHtml(job.city || job.location)}</span>
        ${job.jobType ? `<span class="job-tag">${escapeHtml(job.jobType)}</span>` : ''}
        ${job.salary  ? `<span class="job-tag">💰 ${escapeHtml(job.salary)}</span>`  : ''}
        ${job.isFeatured ? `<span class="job-tag featured">⭐ Featured</span>` : ''}
      </div>
      ${job.skills?.length ? `<div class="kw-tags">${job.skills.slice(0,4).map(s => `<span class="kw-tag">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
      <div class="job-footer">
        <span class="job-date">${formatDate(job.postedAt)}</span>
        <div style="display:flex;gap:8px;align-items:center;">
          ${Auth.isLoggedIn() ? `<button id="${saveId}" onclick="toggleSaveJob('${job.id}', this)" style="background:none;border:1px solid var(--gray-200);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:13px;color:${isSaved ? 'var(--blue)' : 'var(--gray-500)'};" title="${isSaved ? 'Unsave' : 'Save job'}">${isSaved ? '🔖 Saved' : '🔖 Save'}</button>` : ''}
          <span class="btn btn-sm btn-primary" onclick="window.location.href='/job.html?id=${job.id}'">View Job</span>
        </div>
      </div>
    </div>`;
}

async function toggleSaveJob(jobId, btn) {
  if (!btn) return;
  const isSaved = btn.textContent.includes('Saved');
  btn.disabled = true;
  const method = isSaved ? 'DELETE' : 'POST';
  const { ok } = await apiCall(method, `/api/jobs/${jobId}/save`);
  if (ok) {
    btn.textContent = isSaved ? '🔖 Save' : '🔖 Saved';
    btn.style.color = isSaved ? 'var(--gray-500)' : 'var(--blue)';
  }
  btn.disabled = false;
}

// ─── HOMEPAGE STATS ───────────────────────────
async function initHomepage() {
  const statEl = document.getElementById('statJobs');
  if (!statEl) return;
  const { ok, data } = await apiCall('GET', '/api/jobs?limit=1');
  if (ok && data.pagination) statEl.textContent = data.pagination.total.toLocaleString() + '+';
}

// ─── UTILITIES ────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000); // positive = past, negative = future
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 0 && diff < 7) return `${diff} days ago`;
  if (diff < 0 && diff > -7) return `in ${-diff} days`;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function getScoreClass(score) {
  if (score >= 85) return 'score-great';
  if (score >= 65) return 'score-good';
  if (score >= 45) return 'score-fair';
  return 'score-poor';
}

// ─── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initRegisterPage();
  initLoginPage();
  initJobsPage();
  initHomepage();
});

// ─── COOKIE CONSENT (PIPEDA) ─────────────────
(function() {
  if (localStorage.getItem('ctr_consent')) return;
  const bar = document.createElement('div');
  bar.id = 'cookieBar';
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#1e3a5f;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;z-index:9999;font-size:13px;';
  bar.innerHTML = `
    <span>We use cookies to improve your experience. By using ConsTradeHire you agree to our <a href="/privacy.html" style="color:#93c5fd;">Privacy Policy</a> (PIPEDA compliant).</span>
    <div style="display:flex;gap:8px;flex-shrink:0;">
      <button onclick="setCookieConsent('essential')" style="padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;cursor:pointer;font-size:12px;">Essential Only</button>
      <button onclick="setCookieConsent('all')" style="padding:6px 14px;border-radius:6px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;font-weight:700;">Accept All</button>
    </div>`;
  document.body.appendChild(bar);
})();

function setCookieConsent(type) {
  localStorage.setItem('ctr_consent', type);
  const bar = document.getElementById('cookieBar');
  if (bar) bar.remove();
}

// ─── SERVICE WORKER REGISTRATION (PWA) ────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ─── PWA INSTALL PROMPT ───────────────────────
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstall = e;
  // Show install button in navbar if it exists
  const btn = document.getElementById('pwaInstallBtn');
  if (btn) btn.style.display = 'inline-flex';
});

window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  const btn = document.getElementById('pwaInstallBtn');
  if (btn) btn.style.display = 'none';
});

function promptInstall() {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
  _deferredInstall.userChoice.then(() => { _deferredInstall = null; });
}
