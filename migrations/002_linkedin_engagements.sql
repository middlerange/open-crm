CREATE TABLE linkedin_extension_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX linkedin_extension_tokens_user_idx
  ON linkedin_extension_tokens(workspace_id, user_id, active);

CREATE TABLE linkedin_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_post_url text NOT NULL,
  post_url text NOT NULL,
  post_author_name text,
  competitor_name text,
  person_name text NOT NULL,
  profile_url text NOT NULL,
  normalized_profile_url text NOT NULL,
  headline text,
  engagement_type text NOT NULL CHECK (engagement_type IN ('reaction', 'comment')),
  reaction_type text,
  comment_text text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'dismissed')),
  dedupe_key text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);

CREATE INDEX linkedin_engagements_workspace_owner_idx
  ON linkedin_engagements(workspace_id, owner_id, created_at DESC);
CREATE INDEX linkedin_engagements_workspace_status_idx
  ON linkedin_engagements(workspace_id, status, created_at DESC);
CREATE INDEX linkedin_engagements_profile_idx
  ON linkedin_engagements(workspace_id, normalized_profile_url);

CREATE TRIGGER linkedin_engagements_updated_at
  BEFORE UPDATE ON linkedin_engagements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
