ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS current_tools text,
  ADD COLUMN IF NOT EXISTS relevant_capability text,
  ADD COLUMN IF NOT EXISTS buyer_function text,
  ADD COLUMN IF NOT EXISTS research_status text,
  ADD COLUMN IF NOT EXISTS outreach_status text,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

CREATE TABLE account_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  summary text NOT NULL,
  evidence text,
  source_url text,
  observed_at date,
  confidence text CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  source_key text NOT NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_key)
);

CREATE INDEX account_signals_account_idx
  ON account_signals(workspace_id, account_id, observed_at DESC, created_at DESC);

CREATE TABLE contact_channel_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('linkedin', 'email', 'phone')),
  state text NOT NULL CHECK (state IN ('identified', 'requested', 'connected', 'messaged', 'replied')),
  connection_note text,
  requested_at timestamptz,
  connected_at timestamptz,
  last_message_at timestamptz,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, contact_id, channel)
);

CREATE INDEX contact_channel_states_contact_idx
  ON contact_channel_states(workspace_id, contact_id);

CREATE TABLE crm_import_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_source text NOT NULL,
  source_record_key text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'signal', 'activity')),
  entity_id uuid NOT NULL,
  content_hash text NOT NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, import_source, entity_type, source_record_key)
);

CREATE INDEX crm_import_records_entity_idx
  ON crm_import_records(workspace_id, entity_type, entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS activities_workspace_source_external_idx
  ON activities(workspace_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TRIGGER account_signals_updated_at
  BEFORE UPDATE ON account_signals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contact_channel_states_updated_at
  BEFORE UPDATE ON contact_channel_states FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_import_records_updated_at
  BEFORE UPDATE ON crm_import_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
