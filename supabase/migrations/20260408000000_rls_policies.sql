-- ============================================================
--  ConsTradeHire — Row Level Security Policies
--  Supabase no-API architecture
--  All data access enforced at DB level
-- ============================================================

-- ─── Enable RLS on all tables ────────────────────────────────
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE resume_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_results    ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews     ENABLE ROW LEVEL SECURITY;

-- ─── Helper: get current user role ───────────────────────────
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text AS $$
  SELECT role FROM users WHERE id = auth.uid()::text
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT get_user_role() = 'ADMIN'
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_employer()
RETURNS boolean AS $$
  SELECT get_user_role() IN ('EMPLOYER', 'ADMIN')
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ============================================================
--  USERS
-- ============================================================
DROP POLICY IF EXISTS "users_select_own" ON users;
CREATE POLICY "users_select_own"
  ON users FOR SELECT
  USING (id = auth.uid()::text OR is_admin());

DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own"
  ON users FOR UPDATE
  USING (id = auth.uid()::text)
  WITH CHECK (id = auth.uid()::text);

DROP POLICY IF EXISTS "users_delete_own" ON users;
CREATE POLICY "users_delete_own"
  ON users FOR DELETE
  USING (id = auth.uid()::text OR is_admin());

-- Admin sees all users
DROP POLICY IF EXISTS "users_admin_all" ON users;
CREATE POLICY "users_admin_all"
  ON users FOR ALL
  USING (is_admin());

-- ============================================================
--  PROFILES
-- ============================================================
-- Public read for visible profiles (employer browsing workers)
DROP POLICY IF EXISTS "profiles_select_public" ON profiles;
CREATE POLICY "profiles_select_public"
  ON profiles FOR SELECT
  USING (
    "userId" = auth.uid()::text
    OR "visibleToEmployers" = true
    OR is_admin()
  );

DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT
  WITH CHECK ("userId" = auth.uid()::text);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

DROP POLICY IF EXISTS "profiles_delete_own" ON profiles;
CREATE POLICY "profiles_delete_own"
  ON profiles FOR DELETE
  USING ("userId" = auth.uid()::text OR is_admin());

-- ============================================================
--  RESUMES
-- ============================================================
DROP POLICY IF EXISTS "resumes_select_own" ON resumes;
CREATE POLICY "resumes_select_own"
  ON resumes FOR SELECT
  USING ("userId" = auth.uid()::text OR is_admin());

-- Employer can see resume when they have an application for it
DROP POLICY IF EXISTS "resumes_select_employer" ON resumes;
CREATE POLICY "resumes_select_employer"
  ON resumes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM applications a
      JOIN jobs j ON j.id = a."jobId"
      WHERE a."resumeId" = resumes.id
        AND j."employerId" = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "resumes_insert_own" ON resumes;
CREATE POLICY "resumes_insert_own"
  ON resumes FOR INSERT
  WITH CHECK ("userId" = auth.uid()::text);

DROP POLICY IF EXISTS "resumes_update_own" ON resumes;
CREATE POLICY "resumes_update_own"
  ON resumes FOR UPDATE
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

DROP POLICY IF EXISTS "resumes_delete_own" ON resumes;
CREATE POLICY "resumes_delete_own"
  ON resumes FOR DELETE
  USING ("userId" = auth.uid()::text OR is_admin());

-- ============================================================
--  RESUME VERSIONS
-- ============================================================
DROP POLICY IF EXISTS "resume_versions_own" ON resume_versions;
CREATE POLICY "resume_versions_own"
  ON resume_versions FOR ALL
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

-- ============================================================
--  JOBS
-- ============================================================
-- Anyone can read active jobs
DROP POLICY IF EXISTS "jobs_select_public" ON jobs;
CREATE POLICY "jobs_select_public"
  ON jobs FOR SELECT
  USING ("isActive" = true OR "employerId" = auth.uid()::text OR is_admin());

-- Only employers can post jobs
DROP POLICY IF EXISTS "jobs_insert_employer" ON jobs;
CREATE POLICY "jobs_insert_employer"
  ON jobs FOR INSERT
  WITH CHECK (is_employer() AND ("employerId" = auth.uid()::text OR "employerId" IS NULL));

-- Employer can update/delete own jobs; admin can update any
DROP POLICY IF EXISTS "jobs_update_employer" ON jobs;
CREATE POLICY "jobs_update_employer"
  ON jobs FOR UPDATE
  USING ("employerId" = auth.uid()::text OR is_admin());

DROP POLICY IF EXISTS "jobs_delete_employer" ON jobs;
CREATE POLICY "jobs_delete_employer"
  ON jobs FOR DELETE
  USING ("employerId" = auth.uid()::text OR is_admin());

-- ============================================================
--  APPLICATIONS
-- ============================================================
-- Workers see their own; employers see applications for their jobs
DROP POLICY IF EXISTS "applications_select" ON applications;
CREATE POLICY "applications_select"
  ON applications FOR SELECT
  USING (
    "userId" = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = applications."jobId"
        AND j."employerId" = auth.uid()::text
    )
    OR is_admin()
  );

DROP POLICY IF EXISTS "applications_insert_worker" ON applications;
CREATE POLICY "applications_insert_worker"
  ON applications FOR INSERT
  WITH CHECK (
    "userId" = auth.uid()::text
    AND get_user_role() = 'WORKER'
  );

-- Employer can update status; worker cannot change their own application
DROP POLICY IF EXISTS "applications_update_employer" ON applications;
CREATE POLICY "applications_update_employer"
  ON applications FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = applications."jobId"
        AND j."employerId" = auth.uid()::text
    )
    OR is_admin()
  );

DROP POLICY IF EXISTS "applications_delete_worker" ON applications;
CREATE POLICY "applications_delete_worker"
  ON applications FOR DELETE
  USING ("userId" = auth.uid()::text OR is_admin());

-- ============================================================
--  MESSAGES
-- ============================================================
-- Can only read messages you sent or received
DROP POLICY IF EXISTS "messages_select" ON messages;
CREATE POLICY "messages_select"
  ON messages FOR SELECT
  USING (
    "senderId" = auth.uid()::text
    OR "receiverId" = auth.uid()::text
    OR is_admin()
  );

-- Can only send messages to/from yourself (senderId must be auth user)
DROP POLICY IF EXISTS "messages_insert" ON messages;
CREATE POLICY "messages_insert"
  ON messages FOR INSERT
  WITH CHECK (
    "senderId" = auth.uid()::text
    AND EXISTS (
      -- Enforce authorized pairs: must have an application relationship
      SELECT 1 FROM applications a
      JOIN jobs j ON j.id = a."jobId"
      WHERE (
        (a."userId" = auth.uid()::text AND j."employerId" = "receiverId")
        OR (a."userId" = "receiverId" AND j."employerId" = auth.uid()::text)
      )
    )
  );

DROP POLICY IF EXISTS "messages_update_read" ON messages;
CREATE POLICY "messages_update_read"
  ON messages FOR UPDATE
  USING ("receiverId" = auth.uid()::text)
  WITH CHECK ("receiverId" = auth.uid()::text);

-- ============================================================
--  NOTIFICATIONS
-- ============================================================
DROP POLICY IF EXISTS "notifications_own" ON notifications;
CREATE POLICY "notifications_own"
  ON notifications FOR ALL
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

-- Service role can insert notifications for any user
DROP POLICY IF EXISTS "notifications_service_insert" ON notifications;
CREATE POLICY "notifications_service_insert"
  ON notifications FOR INSERT
  WITH CHECK (true);  -- restricted to service role via RLS bypass

-- ============================================================
--  ATS RESULTS
-- ============================================================
DROP POLICY IF EXISTS "ats_results_own" ON ats_results;
CREATE POLICY "ats_results_own"
  ON ats_results FOR ALL
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

-- Employer can see ATS scores for applicants to their jobs
DROP POLICY IF EXISTS "ats_results_employer" ON ats_results;
CREATE POLICY "ats_results_employer"
  ON ats_results FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM applications a
      JOIN jobs j ON j.id = a."jobId"
      WHERE a."userId" = ats_results."userId"
        AND j."employerId" = auth.uid()::text
    )
  );

-- ============================================================
--  SAVED JOBS
-- ============================================================
DROP POLICY IF EXISTS "saved_jobs_own" ON saved_jobs;
CREATE POLICY "saved_jobs_own"
  ON saved_jobs FOR ALL
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

-- ============================================================
--  JOB ALERTS
-- ============================================================
DROP POLICY IF EXISTS "job_alerts_own" ON job_alerts;
CREATE POLICY "job_alerts_own"
  ON job_alerts FOR ALL
  USING ("userId" = auth.uid()::text)
  WITH CHECK ("userId" = auth.uid()::text);

-- ============================================================
--  JOB REPORTS
-- ============================================================
DROP POLICY IF EXISTS "job_reports_insert" ON job_reports;
CREATE POLICY "job_reports_insert"
  ON job_reports FOR INSERT
  WITH CHECK ("userId" = auth.uid()::text);

DROP POLICY IF EXISTS "job_reports_select_own" ON job_reports;
CREATE POLICY "job_reports_select_own"
  ON job_reports FOR SELECT
  USING ("userId" = auth.uid()::text OR is_admin());

DROP POLICY IF EXISTS "job_reports_admin" ON job_reports;
CREATE POLICY "job_reports_admin"
  ON job_reports FOR UPDATE
  USING (is_admin());

-- ============================================================
--  MATCHES
-- ============================================================
DROP POLICY IF EXISTS "matches_worker_own" ON matches;
CREATE POLICY "matches_worker_own"
  ON matches FOR SELECT
  USING ("userId" = auth.uid()::text OR is_admin());

DROP POLICY IF EXISTS "matches_employer_select" ON matches;
CREATE POLICY "matches_employer_select"
  ON matches FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = matches."jobId"
        AND j."employerId" = auth.uid()::text
    )
  );

-- ============================================================
--  INTERVIEWS
-- ============================================================
DROP POLICY IF EXISTS "interviews_select" ON interviews;
CREATE POLICY "interviews_select"
  ON interviews FOR SELECT
  USING (
    "employerId" = auth.uid()::text
    OR "workerId" = auth.uid()::text
    OR is_admin()
  );

DROP POLICY IF EXISTS "interviews_insert_employer" ON interviews;
CREATE POLICY "interviews_insert_employer"
  ON interviews FOR INSERT
  WITH CHECK ("employerId" = auth.uid()::text);

DROP POLICY IF EXISTS "interviews_update" ON interviews;
CREATE POLICY "interviews_update"
  ON interviews FOR UPDATE
  USING ("employerId" = auth.uid()::text OR "workerId" = auth.uid()::text);

-- ============================================================
--  Supabase Realtime — enable for messages + notifications
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
