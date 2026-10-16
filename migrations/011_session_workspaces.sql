ALTER TABLE sessions
  ADD COLUMN selected_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

UPDATE sessions s
SET selected_workspace_id = (
  SELECT m.workspace_id
  FROM memberships m
  WHERE m.user_id = s.user_id
  ORDER BY m.joined_at ASC, m.workspace_id ASC
  LIMIT 1
)
WHERE s.selected_workspace_id IS NULL;

CREATE INDEX sessions_selected_workspace_id_idx ON sessions(selected_workspace_id);
