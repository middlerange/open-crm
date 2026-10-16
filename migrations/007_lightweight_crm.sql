ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS parent_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_status text NOT NULL DEFAULT 'unknown'
    CHECK (consent_status IN ('unknown', 'legitimate_interest', 'opted_in', 'opted_out')),
  ADD COLUMN IF NOT EXISTS preferred_channel text
    CHECK (preferred_channel IS NULL OR preferred_channel IN ('email', 'phone', 'linkedin')),
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS stage_entered_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_workspace_external_idx
  ON accounts(workspace_id, external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_external_idx
  ON contacts(workspace_id, external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_workspace_external_idx
  ON opportunities(workspace_id, external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounts_workspace_archive_idx ON accounts(workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS contacts_workspace_archive_idx ON contacts(workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS opportunities_workspace_archive_idx ON opportunities(workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS accounts_parent_idx ON accounts(parent_account_id);

CREATE TABLE opportunity_contacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'stakeholder',
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, contact_id)
);

CREATE UNIQUE INDEX opportunity_contacts_one_primary_idx
  ON opportunity_contacts(opportunity_id)
  WHERE is_primary = true;
CREATE INDEX opportunity_contacts_workspace_idx ON opportunity_contacts(workspace_id, contact_id);

INSERT INTO opportunity_contacts (workspace_id, opportunity_id, contact_id, role, is_primary, created_by)
SELECT o.workspace_id, o.id, o.primary_contact_id, 'primary', true, o.created_by
FROM opportunities o
WHERE o.primary_contact_id IS NOT NULL
ON CONFLICT (opportunity_id, contact_id) DO NOTHING;

CREATE TABLE opportunity_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  from_stage_id uuid REFERENCES opportunity_stages(id) ON DELETE SET NULL,
  to_stage_id uuid NOT NULL REFERENCES opportunity_stages(id),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX opportunity_stage_history_opportunity_idx
  ON opportunity_stage_history(workspace_id, opportunity_id, changed_at DESC);

INSERT INTO opportunity_stage_history (workspace_id, opportunity_id, to_stage_id, changed_by, note, changed_at)
SELECT workspace_id, id, stage_id, created_by, 'Initial stage', created_at
FROM opportunities;

CREATE TABLE crm_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT 'gray',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX crm_tags_workspace_name_idx ON crm_tags(workspace_id, lower(name));

CREATE TABLE crm_entity_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity')),
  entity_id uuid NOT NULL,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tag_id, entity_type, entity_id)
);

CREATE INDEX crm_entity_tags_entity_idx
  ON crm_entity_tags(workspace_id, entity_type, entity_id);

CREATE TABLE crm_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity')),
  key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL CHECK (
    field_type IN ('text', 'long_text', 'number', 'date', 'checkbox', 'select', 'url', 'email', 'phone', 'user')
  ),
  description text,
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type, key)
);

CREATE INDEX crm_field_definitions_workspace_idx
  ON crm_field_definitions(workspace_id, entity_type, archived_at, position);

CREATE TABLE crm_field_values (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  field_definition_id uuid NOT NULL REFERENCES crm_field_definitions(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity')),
  entity_id uuid NOT NULL,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field_definition_id, entity_id)
);

CREATE INDEX crm_field_values_entity_idx
  ON crm_field_values(workspace_id, entity_type, entity_id);

CREATE TABLE crm_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity', 'activity')),
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort jsonb NOT NULL DEFAULT '{}'::jsonb,
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_id, entity_type, name)
);

CREATE INDEX crm_saved_views_workspace_idx
  ON crm_saved_views(workspace_id, entity_type, shared, owner_id);

CREATE TABLE crm_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  value text NOT NULL,
  reason text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX crm_suppressions_workspace_value_idx
  ON crm_suppressions(workspace_id, kind, lower(value));

CREATE TABLE crm_external_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity', 'activity')),
  entity_id uuid NOT NULL,
  external_id text NOT NULL,
  last_synced_at timestamptz,
  sync_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, entity_type, external_id),
  UNIQUE (workspace_id, provider, entity_type, entity_id)
);

CREATE TABLE crm_enrichment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity')),
  entity_id uuid NOT NULL,
  field_key text NOT NULL,
  proposed_value jsonb NOT NULL,
  source_url text,
  excerpt text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_enrichment_evidence_entity_idx
  ON crm_enrichment_evidence(workspace_id, entity_type, entity_id, status, created_at DESC);

CREATE TRIGGER crm_tags_updated_at
  BEFORE UPDATE ON crm_tags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_field_definitions_updated_at
  BEFORE UPDATE ON crm_field_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_saved_views_updated_at
  BEFORE UPDATE ON crm_saved_views FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_suppressions_updated_at
  BEFORE UPDATE ON crm_suppressions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_external_mappings_updated_at
  BEFORE UPDATE ON crm_external_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
