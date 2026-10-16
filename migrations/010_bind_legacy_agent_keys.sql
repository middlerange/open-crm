UPDATE agent_tokens AS token
SET created_by = (
  SELECT membership.user_id
  FROM memberships AS membership
  JOIN users ON users.id = membership.user_id AND users.active = true
  WHERE membership.workspace_id = token.workspace_id AND membership.role = 'founder'
  ORDER BY membership.joined_at
  LIMIT 1
)
WHERE token.created_by IS NULL;
