// ============================================================
//  ConsTradeHire — Supabase client wrapper
//  Replaces all /api/* fetch calls with direct Supabase access
//  Auth   → supabase.auth.*
//  Data   → supabase.from('table').*  (RLS enforced at DB level)
//  AI     → edge functions (secure, API keys server-side)
//  Files  → supabase.storage.*
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = window.__SUPABASE_URL__;   // injected by server or meta tag
const SUPABASE_ANON = window.__SUPABASE_ANON__;  // injected by server or meta tag
const FN_BASE       = `${SUPABASE_URL}/functions/v1`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true,
    storage:            localStorage
  }
});

// ─── Auth helper ─────────────────────────────
export const auth = {
  async register({ name, email, password, role = 'WORKER' }) {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { name, role },
        emailRedirectTo: `${location.origin}/login.html?verified=1`
      }
    });
    if (error) throw new Error(error.message);

    // Create user row (auth.uid() will match)
    if (data.user) {
      await supabase.from('users').insert({
        id:           data.user.id,
        name,
        email:        email.toLowerCase(),
        passwordHash: '__supabase_auth__',
        role:         role.toUpperCase()
      });
      await supabase.from('profiles').insert({ userId: data.user.id });
    }
    return data;
  },

  async login({ email, password }) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return data;
  },

  async logout() {
    await supabase.auth.signOut();
    localStorage.clear();
    location.href = '/login.html';
  },

  async me() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: profile } = await supabase.from('profiles').select('*').eq('userId', user.id).single();
    const { data: dbUser }  = await supabase.from('users').select('id,name,email,role').eq('id', user.id).single();
    return { ...dbUser, profile };
  },

  async forgotPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/reset-password.html`
    });
    if (error) throw new Error(error.message);
  },

  async resetPassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
  },

  async deleteAccount() {
    // Cascade deletes via schema + RLS
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not logged in');
    await supabase.from('users').delete().eq('id', user.id);
    await supabase.auth.signOut();
  }
};

// ─── Jobs ─────────────────────────────────────
export const jobs = {
  async list({ search, location, type, province, page = 1, limit = 20 } = {}) {
    let q = supabase.from('jobs').select('*', { count: 'exact' }).eq('isActive', true);
    if (search)   q = q.or(`title.ilike.%${search}%,description.ilike.%${search}%,companyName.ilike.%${search}%`);
    if (location) q = q.ilike('location', `%${location}%`);
    if (type)     q = q.eq('jobType', type);
    if (province) q = q.ilike('province', `%${province}%`);
    q = q.order('postedAt', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { jobs: data, total: count, page };
  },

  async get(id) {
    const { data, error } = await supabase.from('jobs').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    // Increment view count
    await supabase.from('jobs').update({ viewCount: (data.viewCount || 0) + 1 }).eq('id', id);
    return data;
  },

  async post(jobData) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('jobs').insert({
      ...jobData,
      employerId: user.id,
      source:     'MANUAL',
      isActive:   true
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async update(id, updates) {
    const { data, error } = await supabase.from('jobs').update(updates).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async remove(id) {
    const { error } = await supabase.from('jobs').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async save(jobId) {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('saved_jobs').upsert({ userId: user.id, jobId });
    if (error) throw new Error(error.message);
  },

  async unsave(jobId) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('saved_jobs').delete().eq('userId', user.id).eq('jobId', jobId);
  },

  async saved() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('saved_jobs').select('*, job:jobs(*)').eq('userId', user.id);
    if (error) throw new Error(error.message);
    return data;
  },

  async report(jobId, reason, details) {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('job_reports').upsert({ userId: user.id, jobId, reason, details });
    if (error) throw new Error(error.message);
  }
};

// ─── Profile ──────────────────────────────────
export const profile = {
  async get() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('profiles').select('*').eq('userId', user.id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  async update(updates) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('profiles')
      .upsert({ ...updates, userId: user.id }, { onConflict: 'userId' })
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  }
};

// ─── Resumes ──────────────────────────────────
export const resumes = {
  async list() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('resumes')
      .select('*, versions:resume_versions(count), applications(count)')
      .eq('userId', user.id)
      .order('isDefault', { ascending: false })
      .order('updatedAt',  { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },

  async get(id) {
    const { data, error } = await supabase.from('resumes')
      .select('*, versions:resume_versions(*)')
      .eq('id', id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  async create({ name, content, aiGenerated = false }) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('resumes').insert({
      userId: user.id, name, content, aiGenerated
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async update(id, updates) {
    const { data, error } = await supabase.from('resumes').update(updates).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async remove(id) {
    await supabase.from('resumes').delete().eq('id', id);
  },

  async setDefault(id) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('resumes').update({ isDefault: false }).eq('userId', user.id);
    await supabase.from('resumes').update({ isDefault: true }).eq('id', id);
  },

  // Upload + parse (calls edge function)
  async upload(file) {
    const session = await supabase.auth.getSession();
    const token   = session.data.session?.access_token;
    const form    = new FormData();
    form.append('resume', file);
    const res = await fetch(`${FN_BASE}/parse-resume`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
      body:    form
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
    return res.json();
  },

  // Versions
  async versions(resumeId) {
    const { data, error } = await supabase.from('resume_versions')
      .select('*').eq('resumeId', resumeId).order('version', { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },

  async saveVersion(resumeId, { label, content, tailoredFor, aiGenerated } = {}) {
    const { data: last } = await supabase.from('resume_versions')
      .select('version').eq('resumeId', resumeId).order('version', { ascending: false }).limit(1).maybeSingle();
    const nextVersion = (last?.version || 0) + 1;
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('resume_versions').insert({
      resumeId, userId: user.id, version: nextVersion,
      label: label || `Version ${nextVersion}`, content, tailoredFor, aiGenerated
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteVersion(versionId) {
    await supabase.from('resume_versions').delete().eq('id', versionId);
  },

  // AI tailor (calls edge function — API key stays server-side)
  async tailor(resumeId, jobId) {
    const session = await supabase.auth.getSession();
    const token   = session.data.session?.access_token;
    const res = await fetch(`${FN_BASE}/ai-resume`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'tailor', resumeId, jobId })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Tailoring failed');
    return res.json();
  }
};

// ─── Applications ─────────────────────────────
export const applications = {
  async apply({ jobId, resumeId, coverLetter }) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('applications').insert({
      userId: user.id, jobId, resumeId, coverLetter, status: 'APPLIED'
    }).select().single();
    if (error) {
      if (error.code === '23505') throw new Error('You have already applied to this job');
      throw new Error(error.message);
    }
    return data;
  },

  async mine() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('applications')
      .select('*, job:jobs(*), resume:resumes(id,name,fileUrl)')
      .eq('userId', user.id).order('appliedAt', { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },

  async forJob(jobId) {
    const { data, error } = await supabase.from('applications')
      .select('*, user:users(id,name,email), resume:resumes(id,name,content,fileUrl)')
      .eq('jobId', jobId).order('appliedAt', { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },

  async updateStatus(id, status) {
    const { data, error } = await supabase.from('applications')
      .update({ status }).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
};

// ─── Messages ─────────────────────────────────
export const messages = {
  async conversation(otherUserId) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('messages')
      .select('*')
      .or(`and(senderId.eq.${user.id},receiverId.eq.${otherUserId}),and(senderId.eq.${otherUserId},receiverId.eq.${user.id})`)
      .order('createdAt', { ascending: true });
    if (error) throw new Error(error.message);
    return data;
  },

  async send(receiverId, content) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('messages')
      .insert({ senderId: user.id, receiverId, content }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async markRead(senderId) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('messages')
      .update({ read: true })
      .eq('senderId', senderId).eq('receiverId', user.id).eq('read', false);
  },

  // Real-time subscription
  subscribe(userId, onMessage) {
    return supabase
      .channel('messages')
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'messages',
        filter: `receiverId=eq.${userId}`
      }, payload => onMessage(payload.new))
      .subscribe();
  }
};

// ─── Notifications ────────────────────────────
export const notifications = {
  async list() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('notifications')
      .select('*').eq('userId', user.id).order('createdAt', { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    return data;
  },

  async markRead(id) {
    await supabase.from('notifications').update({ read: true }).eq('id', id);
  },

  async markAllRead() {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('notifications').update({ read: true }).eq('userId', user.id).eq('read', false);
  },

  // Real-time subscription
  subscribe(userId, onNotification) {
    return supabase
      .channel('notifications')
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'notifications',
        filter: `userId=eq.${userId}`
      }, payload => onNotification(payload.new))
      .subscribe();
  }
};

// ─── ATS Scoring ──────────────────────────────
export const ats = {
  async score({ resumeText, jobDescription, jobId, resumeId }) {
    const session = await supabase.auth.getSession();
    const token   = session.data.session?.access_token;
    const res = await fetch(`${FN_BASE}/ats-score`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ resumeText, jobDescription, jobId, resumeId })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'ATS scoring failed');
    const { result } = await res.json();
    return result;
  },

  async history() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('ats_results')
      .select('*').eq('userId', user.id).order('createdAt', { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  }
};

// ─── AI features (edge functions) ────────────
export const ai = {
  async _call(action, body = {}) {
    const session = await supabase.auth.getSession();
    const token   = session.data.session?.access_token;
    const res = await fetch(`${FN_BASE}/ai-resume`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action, ...body })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'AI request failed');
    return res.json();
  },

  generateResume(userPrompt, systemPrompt, maxTokens)  { return this._call('generate',       { userPrompt, systemPrompt, maxTokens }); },
  rewriteBullets(rawExperience, jobTitle, company)     { return this._call('exp-bullets',    { rawExperience, jobTitle, company }); },
  coverLetter(userPrompt, systemPrompt)                { return this._call('cover-letter',   { userPrompt, systemPrompt }); },
  interviewPrep(params)                                { return this._call('interview-prep', params); },
  followUp(params)                                     { return this._call('follow-up',      params); }
};

// ─── Job Alerts ───────────────────────────────
export const alerts = {
  async list() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('job_alerts').select('*').eq('userId', user.id);
    if (error) throw new Error(error.message);
    return data;
  },

  async create(alertData) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('job_alerts')
      .insert({ ...alertData, userId: user.id }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async remove(id) {
    await supabase.from('job_alerts').delete().eq('id', id);
  }
};
