CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('founder', 'manager', 'ic')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('manager', 'ic')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_pending_email_idx
  ON invitations(workspace_id, lower(email))
  WHERE accepted_at IS NULL;

CREATE TABLE agent_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['read', 'write']::text[],
  active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  domain text,
  normalized_domain text,
  linkedin_url text,
  normalized_linkedin_url text,
  website_url text,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  tier text NOT NULL DEFAULT 'C' CHECK (tier IN ('A', 'B', 'C')),
  status text NOT NULL DEFAULT 'research' CHECK (
    status IN ('research', 'pending_approval', 'approved', 'active', 'nurture', 'disqualified')
  ),
  employee_range text,
  product_motion text,
  source text,
  fit_summary text,
  evidence_summary text,
  trigger_summary text,
  source_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  score integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  disqualification_reason text,
  next_action text,
  next_action_at timestamptz,
  last_activity_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_workspace_domain_idx
  ON accounts(workspace_id, normalized_domain)
  WHERE normalized_domain IS NOT NULL;
CREATE UNIQUE INDEX accounts_workspace_linkedin_idx
  ON accounts(workspace_id, normalized_linkedin_url)
  WHERE normalized_linkedin_url IS NOT NULL;
CREATE INDEX accounts_workspace_owner_idx ON accounts(workspace_id, owner_id);
CREATE INDEX accounts_workspace_status_idx ON accounts(workspace_id, status);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  first_name text NOT NULL,
  last_name text,
  title text,
  department text,
  email text,
  normalized_email text,
  linkedin_url text,
  normalized_linkedin_url text,
  phone text,
  buyer_role text,
  status text NOT NULL DEFAULT 'identified' CHECK (
    status IN ('identified', 'verified', 'contacted', 'engaged', 'qualified', 'not_interested', 'invalid')
  ),
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contacts_workspace_email_idx
  ON contacts(workspace_id, normalized_email)
  WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX contacts_workspace_linkedin_idx
  ON contacts(workspace_id, normalized_linkedin_url)
  WHERE normalized_linkedin_url IS NOT NULL;
CREATE INDEX contacts_account_idx ON contacts(account_id);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'active', 'paused', 'complete', 'archived')
  ),
  segment text,
  hypothesis text,
  value_proposition text,
  channels text[] NOT NULL DEFAULT ARRAY[]::text[],
  success_metric text,
  start_at date,
  end_at date,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaigns_workspace_status_idx ON campaigns(workspace_id, status);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('email_sequence', 'outreach_draft', 'content', 'video', 'demo', 'teardown')),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'idea' CHECK (
    status IN ('idea', 'brief', 'draft', 'production', 'pending_approval', 'changes_requested', 'approved', 'scheduled', 'published', 'archived')
  ),
  use_case text,
  channel text,
  brief text,
  body text,
  external_url text,
  due_at timestamptz,
  published_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_workspace_type_status_idx ON assets(workspace_id, type, status);
CREATE INDEX assets_workspace_owner_idx ON assets(workspace_id, owner_id);

CREATE TABLE opportunity_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  probability integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  terminal boolean NOT NULL DEFAULT false,
  won boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key),
  UNIQUE (workspace_id, position)
);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  primary_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  stage_id uuid NOT NULL REFERENCES opportunity_stages(id),
  name text NOT NULL,
  value_amount numeric(14,2),
  currency text NOT NULL DEFAULT 'USD',
  problem_summary text,
  next_action text NOT NULL,
  next_action_at timestamptz NOT NULL,
  expected_close_at date,
  loss_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX opportunities_workspace_owner_idx ON opportunities(workspace_id, owner_id);
CREATE INDEX opportunities_workspace_stage_idx ON opportunities(workspace_id, stage_id);
CREATE INDEX opportunities_next_action_idx ON opportunities(next_action_at);

CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES work_items(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  workstream text NOT NULL CHECK (workstream IN ('outbound', 'content', 'video', 'sales', 'operations')),
  kind text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'backlog' CHECK (
    status IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled')
  ),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  entity_type text,
  entity_id uuid,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  blocked_reason text,
  estimate_minutes integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_items_workspace_owner_status_idx ON work_items(workspace_id, owner_id, status);
CREATE INDEX work_items_workspace_due_idx ON work_items(workspace_id, due_at);

CREATE TABLE activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  work_item_id uuid REFERENCES work_items(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (
    type IN ('email', 'linkedin_request', 'linkedin_message', 'follow_up', 'call', 'meeting', 'note', 'research', 'demo', 'teardown')
  ),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('planned', 'completed', 'skipped')),
  outcome text,
  details text,
  occurred_at timestamptz,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activities_workspace_actor_idx ON activities(workspace_id, actor_id, created_at DESC);
CREATE INDEX activities_account_idx ON activities(account_id, created_at DESC);
CREATE INDEX activities_due_idx ON activities(workspace_id, due_at) WHERE status = 'planned';

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('account', 'campaign', 'asset')),
  subject_id uuid NOT NULL,
  gate text NOT NULL CHECK (gate IN ('lead', 'campaign_asset')),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'changes_requested', 'rejected', 'cancelled')
  ),
  requested_by uuid NOT NULL REFERENCES users(id),
  reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  request_note text,
  decision_note text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE UNIQUE INDEX approvals_one_pending_subject_idx
  ON approvals(workspace_id, subject_type, subject_id, gate)
  WHERE status = 'pending';
CREATE INDEX approvals_workspace_status_idx ON approvals(workspace_id, status, requested_at);

CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  metric text NOT NULL,
  label text NOT NULL,
  target numeric(14,2) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_id, metric, period_start, period_end)
);

CREATE TABLE daily_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  update_date date NOT NULL DEFAULT current_date,
  moved text NOT NULL,
  stuck text,
  learned text,
  tomorrow text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, update_date)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_label text,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  channel text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX audit_logs_idempotency_idx
  ON audit_logs(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX audit_logs_workspace_created_idx ON audit_logs(workspace_id, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assets_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER opportunities_updated_at BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER work_items_updated_at BEFORE UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER goals_updated_at BEFORE UPDATE ON goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER daily_updates_updated_at BEFORE UPDATE ON daily_updates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
