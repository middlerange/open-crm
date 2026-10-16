ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS token_hint text;

CREATE INDEX IF NOT EXISTS agent_tokens_created_by_idx
  ON agent_tokens(created_by, created_at DESC);
