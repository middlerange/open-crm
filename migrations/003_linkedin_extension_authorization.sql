CREATE TABLE linkedin_extension_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  token_label text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX linkedin_extension_authorization_codes_expiry_idx
  ON linkedin_extension_authorization_codes(expires_at)
  WHERE used_at IS NULL;
