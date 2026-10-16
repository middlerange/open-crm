CREATE TABLE linkedin_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_post_url text NOT NULL,
  post_url text NOT NULL,
  post_author_name text,
  competitor_name text,
  post_text text,
  post_published_at timestamptz,
  reaction_count integer NOT NULL DEFAULT 0 CHECK (reaction_count >= 0),
  comment_count integer NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  repost_count integer NOT NULL DEFAULT 0 CHECK (repost_count >= 0),
  capture_runs integer NOT NULL DEFAULT 1 CHECK (capture_runs >= 1),
  active boolean NOT NULL DEFAULT true,
  first_captured_at timestamptz NOT NULL,
  last_captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, normalized_post_url)
);

CREATE INDEX linkedin_sources_workspace_owner_idx
  ON linkedin_sources(workspace_id, owner_id, last_captured_at DESC);

CREATE TRIGGER linkedin_sources_updated_at
  BEFORE UPDATE ON linkedin_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE linkedin_engagements
  ADD COLUMN source_id uuid REFERENCES linkedin_sources(id) ON DELETE SET NULL,
  ADD COLUMN company_name text,
  ADD COLUMN location text,
  ADD COLUMN connection_degree text;

CREATE INDEX linkedin_engagements_source_idx ON linkedin_engagements(source_id);
