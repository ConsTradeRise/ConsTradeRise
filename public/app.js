// ─────────────────────────────────────────────
//  ConsTradeRise — Frontend App
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
    else window.location.href = '/dashboard.html';
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
  el.innerHTML = data.notifications.map(n => `
    <div onclick="${n.link ? `window.location.href='${n.link}'` : ''}" style="padding:12px 16px;border-bottom:1px solid var(--gray-100);cursor:${n.link?'pointer':'default'};background:${n.read?'#fff':'var(--blue-light)'};">
      <div style="font-size:13px;font-weight:${n.read?'400':'700'};color:var(--gray-900);">${escapeHtml(n.title)}</div>
      <div style="font-size:12px;color:var(--gray-500);margin-top:2px;">${escapeHtml(n.body)}</div>
      <div style="font-size:11px;color:var(--gray-400);margin-top:4px;">${formatDate(n.createdAt)}</div>
    </div>`).join('');
  fetchNotifCount();
}

async function markAllRead() {
  await apiCall('PUT', '/api/notifications/read-all');
  loadNotifications();
  const el = document.getElementById('notifCount');
  if (el) el.style.display = 'none';
}

// ─── REGISTER PAGE ────────────────────────────
function initRegisterPage() {
  const form = document.getElementById('registerForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn    = document.getElementById('regBtn');
    const errorEl = document.getElementById('registerError');

    const role    = document.getElementById('regRole')?.value || 'WORKER';
    const name    = document.getElementById('regName').value.trim();
    const email   = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const company = document.getElementById('regCompany')?.value.trim() || '';

    if (!name || !email || !password) {
      if (errorEl) { errorEl.textContent = 'All fields are required'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (password.length < 8) {
      if (errorEl) { errorEl.textContent = 'Password must be at least 8 characters'; errorEl.classList.remove('hidden'); }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating account...';

    const payload = { name, email, password, role };
    if (role === 'EMPLOYER' && company) payload.company = company;

    const { ok, data } = await apiCall('POST', '/api/auth/register', payload);

    if (ok) {
      Auth.save(data.token, data.user);
      Toast.success('Account created! Welcome to ConsTradeRise.');
      setTimeout(() => Auth.redirectToDashboard(), 800);
    } else {
      if (errorEl) { errorEl.textContent = data.error || 'Registration failed'; errorEl.classList.remove('hidden'); }
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });
}

// ─── LOGIN PAGE ───────────────────────────────
function initLoginPage() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  // Redirect if already logged in
  if (Auth.isLoggedIn()) {
    Auth.redirectToDashboard();
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const errorEl = document.getElementById('loginError');

    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    btn.disabled = true;
    btn.textContent = 'Logging in...';

    const { ok, data } = await apiCall('POST', '/api/auth/login', { email, password });

    if (ok) {
      Auth.save(data.token, data.user);
      Toast.success('Welcome back!');
      const next = new URLSearchParams(window.location.search).get('next');
      setTimeout(() => {
        if (next) window.location.href = next;
        else Auth.redirectToDashboard();
      }, 600);
    } else {
      if (errorEl) { errorEl.textContent = data.error || 'Login failed'; errorEl.classList.remove('hidden'); }
      btn.disabled = false;
      btn.textContent = 'Login';
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

function renderJobCard(job) {
  const score    = job.atsScore;
  const scoreHtml = score
    ? `<span class="ats-score-badge ${getScoreClass(score.score)}">${score.score}%</span>`
    : '';

  return `
    <div class="job-card" onclick="window.location.href='/job.html?id=${job.id}'">
      <div class="job-card-header">
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
        <span class="btn btn-sm btn-primary">View Job</span>
      </div>
    </div>`;
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
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7)  return `${diff} days ago`;
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
