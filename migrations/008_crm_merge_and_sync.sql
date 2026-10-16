ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS accounts_merged_into_idx ON accounts(merged_into_id);
CREATE INDEX IF NOT EXISTS contacts_merged_into_idx ON contacts(merged_into_id);

CREATE TABLE crm_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_email text NOT NULL,
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'syncing', 'error', 'revoked')),
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  sync_mail boolean NOT NULL DEFAULT true,
  sync_calendar boolean NOT NULL DEFAULT true,
  auto_create_contacts boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, account_email)
);

CREATE INDEX crm_connections_workspace_user_idx
  ON crm_connections(workspace_id, user_id, status);

CREATE TABLE crm_email_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  provider_thread_id text NOT NULL,
  subject text,
  snippet text,
  latest_message_at timestamptz,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_thread_id)
);

CREATE INDEX crm_email_threads_entity_idx
  ON crm_email_threads(workspace_id, account_id, contact_id, opportunity_id, latest_message_at DESC);

CREATE TABLE crm_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES crm_email_threads(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at timestamptz NOT NULL,
  text_body text,
  html_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, provider_message_id)
);

CREATE INDEX crm_email_messages_thread_idx ON crm_email_messages(thread_id, sent_at);

CREATE TABLE crm_calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL,
  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location text,
  meeting_url text,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_event_id)
);

CREATE INDEX crm_calendar_events_entity_idx
  ON crm_calendar_events(workspace_id, account_id, contact_id, opportunity_id, starts_at DESC);

CREATE TRIGGER crm_connections_updated_at
  BEFORE UPDATE ON crm_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_email_threads_updated_at
  BEFORE UPDATE ON crm_email_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_calendar_events_updated_at
  BEFORE UPDATE ON crm_calendar_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
