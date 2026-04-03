# TradesUp AI — Master Build Roadmap
> AI-Powered Construction & Labour Job Platform (Canada-first)
> Last updated: 2026-04-02

---

## OVERVIEW

| Phase | Name | Priority | Status |
|-------|------|----------|--------|
| 1 | Core MVP | Critical | Not started |
| 2 | AI Resume Builder | High | Not started |
| 3 | ATS Scoring Engine | High | Not started |
| 4 | Application System | High | Not started |
| 5 | Labour System + Matching | Medium | Not started |
| 6 | Business + Trust | Medium | Not started |
| 7 | Scale + Analytics | Low | Not started |

---

## PHASE 1 — CORE MVP
**Goal:** Working platform with auth, profiles, and jobs

### 1.1 Project Setup
- [ ] Initialize Next.js project (App Router)
- [ ] Set up PostgreSQL database (local + cloud)
- [ ] Set up Prisma ORM + schema
- [ ] Configure environment variables
- [ ] Set up folder structure (frontend + backend)
- [ ] Configure ESLint + Prettier
- [ ] Set up Git repository

### 1.2 Database Schema
- [ ] users table (id, name, email, password_hash, role, created_at)
- [ ] profiles table (user_id, skills, experience, location, visibility_settings)
- [ ] resumes table (id, user_id, content, file_url, created_at)
- [ ] jobs table (id, title, description, location, employer_id, source, external_id)
- [ ] applications table (id, user_id, job_id, resume_id, status)
- [ ] messages table (id, sender_id, receiver_id, content, created_at)
- [ ] notifications table (id, user_id, type, content, read, created_at)
- [ ] Run migrations

### 1.3 Authentication System
- [ ] POST /api/auth/register (worker + employer)
- [ ] POST /api/auth/login → returns JWT
- [ ] POST /api/auth/logout
- [ ] POST /api/auth/forgot-password
- [ ] POST /api/auth/reset-password
- [ ] Email verification flow
- [ ] JWT middleware (protect routes)
- [ ] Role-based access control middleware
- [ ] Password hashing with bcrypt
- [ ] Rate limiting on auth routes

### 1.4 User Profile System
- [ ] GET /api/profile/:id
- [ ] PUT /api/profile/update
- [ ] Profile visibility settings (control matching visibility)
- [ ] Skills tag system
- [ ] Experience fields
- [ ] Location fields
- [ ] Profile photo upload

### 1.5 Job System (Basic)
- [ ] GET /api/jobs (list with filters)
- [ ] GET /api/jobs/:id (job detail)
- [ ] POST /api/jobs (employer post job)
- [ ] PUT /api/jobs/:id (employer update)
- [ ] DELETE /api/jobs/:id (employer delete)
- [ ] Job search (title, location, skills)
- [ ] Job filters (type, location, salary)
- [ ] Save/bookmark jobs

### 1.6 File Upload System
- [ ] PDF-only validation
- [ ] File size limit (5MB)
- [ ] Secure cloud storage (S3 or Cloudflare R2)
- [ ] File scanning (malware check)
- [ ] Secure file URL generation
- [ ] File deletion

### 1.7 Frontend — Core Pages
- [ ] Home page (landing)
- [ ] Sign up page (worker / employer)
- [ ] Login page
- [ ] Worker dashboard
- [ ] Employer dashboard
- [ ] Jobs listing page
- [ ] Job detail page
- [ ] Profile page
- [ ] Settings page
- [ ] Mobile-first responsive layout
- [ ] Navigation (header + sidebar)

### 1.8 Live Job Aggregation
- [ ] Adzuna API integration
- [ ] Jooble API integration
- [ ] Data normalization layer
- [ ] Deduplication logic
- [ ] Cron job (fetch every 6 hours)
- [ ] Store aggregated jobs in DB
- [ ] Tag source (api vs manual)

**Phase 1 Exit Criteria:**
- User can register, login, view jobs, and post jobs
- Auth is secure with role-based access
- Live jobs are pulling from APIs

---

## PHASE 2 — AI RESUME BUILDER
**Goal:** Users can build, upload, and manage resumes with AI assistance

### 2.1 Resume Upload
- [ ] Upload PDF resume
- [ ] Parse resume text (PDF to text)
- [ ] Store parsed content in DB
- [ ] Resume preview in browser
- [ ] resumes table extended

### 2.2 Resume Builder (AI)
- [ ] Resume builder UI (form-based)
- [ ] AI fills sections from user input
- [ ] Experience text → professional bullet points
- [ ] Skills auto-suggestion
- [ ] Export resume as PDF
- [ ] Resume templates (2-3 clean designs)

### 2.3 Experience → Resume Conversion
- [ ] User types raw experience (e.g. "worked on site helping workers")
- [ ] AI converts to professional resume lines
- [ ] Claude API integration (claude-sonnet-4-6)
- [ ] Output validation (prevent hallucination/exaggeration)
- [ ] User can edit AI output before saving

### 2.4 Resume Library
- [ ] resume_versions table (id, resume_id, version, content, created_at)
- [ ] Save multiple resume versions
- [ ] Name/label each version
- [ ] Set default resume
- [ ] Delete versions
- [ ] Resume history view

### 2.5 Resume Tailoring
- [ ] Select a job → tailor resume to that job
- [ ] AI rewrites resume to match job keywords
- [ ] Save as new version
- [ ] Side-by-side comparison (original vs tailored)

**Phase 2 Exit Criteria:**
- User can upload, build, and manage multiple resume versions
- AI can convert raw experience to professional resume content

---

## PHASE 3 — ATS SCORING ENGINE
**Goal:** Show workers their ATS match score for every job

### 3.1 ATS Engine Core
- [ ] ats_results table (id, user_id, job_id, resume_id, score, details, created_at)
- [ ] Keyword extraction from job description
- [ ] Keyword extraction from resume
- [ ] Score calculation logic:
  - Keyword match → 40%
  - Skills match → 20%
  - Experience relevance → 20%
  - Job title relevance → 10%
  - Formatting score → 10%
- [ ] Total score 0–100
- [ ] Cache results (avoid re-computing same resume+job)

### 3.2 ATS API
- [ ] POST /api/ats/score (resume_id + job_id → score)
- [ ] GET /api/ats/results/:user_id (history)
- [ ] Response time target: <3 seconds

### 3.3 ATS Output Display
- [ ] Score badge on every job card ("ATS Match: 82%")
- [ ] Score detail page:
  - Matched keywords (green checkmarks)
  - Missing keywords (red X)
  - Weak areas (yellow warning)
  - Specific improvement suggestions
- [ ] Match strength label (Excellent / Good / Fair / Poor)

### 3.4 Resume Improvement Suggestions
- [ ] AI generates specific suggestions based on gap
- [ ] "Add these keywords to your resume"
- [ ] "Your experience section needs more detail"
- [ ] One-click apply suggestion to resume builder

### 3.5 Employer ATS View
- [ ] Employer sees candidates ranked by ATS score
- [ ] Filter applicants by minimum score
- [ ] ATS breakdown visible to employer (limited)

**Phase 3 Exit Criteria:**
- Every job shows an ATS score for the worker's resume
- Suggestions are actionable and accurate
- Employer can rank/filter by score

---

## PHASE 4 — APPLICATION SYSTEM
**Goal:** Workers can apply on-platform or via email with resume + cover letter

### 4.1 On-Platform Apply
- [ ] POST /api/applications (apply to job)
- [ ] Select which resume version to attach
- [ ] Application status tracking (applied, viewed, shortlisted, rejected)
- [ ] Employer notified on new application
- [ ] Worker notified on status change
- [ ] Prevent duplicate applications

### 4.2 Apply via Email
- [ ] Generate professional email to employer
- [ ] AI drafts email based on job + resume
- [ ] User edits before sending
- [ ] Attach resume (PDF)
- [ ] Attach cover letter (optional)
- [ ] Send via platform email relay

### 4.3 Cover Letter System
- [ ] cover_letters table
- [ ] AI generates cover letter (job + resume input)
- [ ] User edits output
- [ ] Save cover letter versions
- [ ] Attach to application or email

### 4.4 Application Dashboard
- [ ] Worker: see all applications + statuses
- [ ] Employer: see all applicants per job
- [ ] Employer: ranked by ATS score
- [ ] Employer: filter by status, score, location
- [ ] Employer can ONLY see their own job's applicants

**Phase 4 Exit Criteria:**
- Workers can apply on-platform and via email
- Employers can manage and rank applicants
- Cover letters are generated and attachable

---

## PHASE 5 — LABOUR SYSTEM + MATCHING
**Goal:** Labour workers (no resume) can join fast, AI matches jobs to candidates

### 5.1 Labour Fast Profile
- [ ] Simplified onboarding (no resume required)
- [ ] Skills selection (tag-based)
- [ ] Experience description (free text)
- [ ] Availability (days/hours)
- [ ] Location + travel radius
- [ ] AI converts profile → resume automatically

### 5.2 AI Job Matching Engine
- [ ] Match workers to jobs by: skills, experience, location, availability
- [ ] Score each match (0–100)
- [ ] matches table (id, job_id, user_id, score, created_at)
- [ ] Show "Recommended Jobs" on worker dashboard
- [ ] Employer can see matched candidates (limited profile data)
- [ ] Worker controls visibility (opt-in/out of matching)

### 5.3 Messaging System
- [ ] Real-time chat (WebSocket or Pusher)
- [ ] Employer ↔ Worker only (authorized pairs)
- [ ] Message stored in DB
- [ ] Unread count + notifications
- [ ] Block/report user
- [ ] No external contact sharing via messages

### 5.4 Notifications System
- [ ] Job alerts (new jobs matching skills)
- [ ] Application status updates
- [ ] New message alerts
- [ ] Resume improvement reminders
- [ ] Email + in-app notifications

**Phase 5 Exit Criteria:**
- Labour workers can join without a resume
- Jobs are matched and recommended intelligently
- Messaging works securely between authorized users

---

## PHASE 6 — BUSINESS + TRUST
**Goal:** Revenue model, admin panel, trust systems

### 6.1 Admin Panel
- [ ] Admin dashboard (user/job counts, activity)
- [ ] User management (ban, verify, delete)
- [ ] Job moderation (approve, flag, remove)
- [ ] Reports management
- [ ] System health view
- [ ] Access: admin role only

### 6.2 Trust + Safety
- [ ] User verification system
- [ ] Report user / job
- [ ] Ratings & reviews (employer ↔ worker)
- [ ] Moderation queue for reports
- [ ] Verified badge on profiles

### 6.3 Payment System
- [ ] Employer job posting fees
- [ ] Featured job listings (paid)
- [ ] Worker premium AI tools (subscription)
- [ ] Stripe integration
- [ ] Invoice + billing history
- [ ] Free tier limits (e.g. 1 free job post/month)

### 6.4 PIPEDA Legal Compliance
- [ ] Privacy Policy page
- [ ] Terms & Conditions page
- [ ] Cookie consent banner
- [ ] User consent on signup
- [ ] Data deletion (user can delete account + all data)
- [ ] Data export (user can download their data)
- [ ] Consent logging in DB

**Phase 6 Exit Criteria:**
- Platform generates revenue
- Admin can moderate safely
- Platform is legally compliant in Canada

---

## PHASE 7 — SCALE + ANALYTICS
**Goal:** Optimize, track, grow

### 7.1 Analytics
- [ ] User growth tracking
- [ ] Application funnel analysis
- [ ] Job view → apply conversion rates
- [ ] Drop-off point analysis
- [ ] AI usage metrics
- [ ] Dashboard for admin

### 7.2 Performance Optimization
- [ ] API response caching (Redis)
- [ ] Database query optimization + indexes
- [ ] Image/file CDN
- [ ] Lazy loading on frontend
- [ ] Lighthouse score target: 90+

### 7.3 Retention System
- [ ] Weekly job alert emails
- [ ] Resume improvement nudges
- [ ] "New jobs matching your skills" push notifications
- [ ] Re-engagement emails (inactive users)

### 7.4 AI Usage Control
- [ ] Track Claude API usage per user
- [ ] Rate limit AI calls (prevent abuse)
- [ ] Output validation (hallucination check)
- [ ] Fallback if AI fails (retry + error message)

### 7.5 Deployment + DevOps
- [ ] Frontend → Vercel
- [ ] Backend → Railway or Render
- [ ] Database → Supabase or Neon (PostgreSQL cloud)
- [ ] File storage → Cloudflare R2 or AWS S3
- [ ] CI/CD pipeline (GitHub Actions)
- [ ] Environment management (dev / staging / prod)
- [ ] Error monitoring (Sentry)
- [ ] Uptime monitoring

**Phase 7 Exit Criteria:**
- Platform handles 1000+ concurrent users
- Analytics inform product decisions
- Retention loops are active

---

## TECH STACK (FINAL)

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router) |
| Styling | Tailwind CSS |
| Backend | Next.js API Routes + Node.js |
| Database | PostgreSQL |
| ORM | Prisma |
| Auth | JWT + bcrypt |
| AI | Claude API (claude-sonnet-4-6) |
| File Storage | Cloudflare R2 / AWS S3 |
| Real-time | Pusher / WebSockets |
| Email | Resend / SendGrid |
| Payments | Stripe |
| Caching | Redis |
| Deployment | Vercel + Railway |
| Monitoring | Sentry |
| Job APIs | Adzuna + Jooble |

---

## SECURITY CHECKLIST (ALL PHASES)

- [ ] JWT on all protected routes
- [ ] Role check middleware (worker / employer / admin)
- [ ] Employer can only access their own jobs + applicants
- [ ] PDF-only file uploads with scanning
- [ ] Rate limiting on all APIs (especially auth + AI)
- [ ] Input validation + sanitization (prevent XSS, SQLi)
- [ ] CAPTCHA on register + login
- [ ] HTTPS only
- [ ] Secrets in environment variables only
- [ ] API keys never exposed to frontend

---

## TIMELINE ESTIMATE

| Phase | Estimated Duration |
|-------|--------------------|
| Phase 1 | 3–4 weeks |
| Phase 2 | 2–3 weeks |
| Phase 3 | 2 weeks |
| Phase 4 | 2 weeks |
| Phase 5 | 3 weeks |
| Phase 6 | 2–3 weeks |
| Phase 7 | Ongoing |
| **Total to MVP** | **~8–10 weeks** |

---

## WHAT TO BUILD FIRST

1. Add auth + Prisma to existing Express backend
2. Set up PostgreSQL + Prisma schema
3. Build auth system (register / login / JWT)
4. Build job listing + landing pages
5. Ship Phase 1

---

## SUGGESTIONS INCLUDED (Pre-Build Decisions)

### Validated Before Building
- [ ] Talk to 5–10 real construction workers/employers in Ontario before Phase 2
- [ ] Confirm Adzuna + Jooble API Terms of Service allow commercial use

### Niche Focus (Launch Target)
- Skilled trades in Ontario only at launch
- Expand to other provinces after traction

### Scope Reductions (Applied)
- Real-time messaging → email notifications in Phase 1, WebSocket in Phase 5
- Labour system → Phase 5 only (don't build early)
- Complex ML matching → keyword-based matching first, upgrade in Phase 5
- Next.js migration → Phase 7 (existing Express backend is the foundation)

### Stack Decision
- Keep existing Express.js backend (already has Claude AI integrated)
- Build frontend as clean HTML/CSS/JS (fast to ship, no framework needed for MVP)
- Add PostgreSQL + Prisma on top of existing server
- Migrate to Next.js in Phase 7 when scaling

### ATS Score = #1 Marketing Feature
- Show ATS score prominently on every job card
- This is the unique differentiator — no Canadian construction board has this
- Market it as the headline feature

### Revenue Priority
- Employer side = revenue → build employer features with high polish
- Worker features are free → focus on volume

### Supabase vs Raw PostgreSQL
- Use Supabase for Phase 1 (PostgreSQL + auth + storage + real-time in one)
- Saves weeks of infrastructure setup
- Free tier is sufficient for MVP

---
*TradesUp AI — Build Roadmap v1.1 (updated 2026-04-02)*
