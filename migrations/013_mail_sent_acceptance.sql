-- Earlier releases recorded successful provider handoff as queued. Preserve the
-- recipient delivery results; Sent only confirms handoff, not final delivery.
WITH accepted_drafts AS (
  UPDATE mail_drafts SET status = 'sent'
  WHERE status = 'queued' AND error IS NULL AND send_completed_at IS NOT NULL
    AND provider_message_id <> ''
    AND delivery_result->>'messageId' = provider_message_id
    AND delivery_result->>'status' = 'queued'
    AND jsonb_typeof(delivery_result->'queued') = 'array'
    AND delivery_result->'queued' <> '[]'::jsonb
  RETURNING workspace_id, mailbox_id, conversation_id, provider_message_id
)
UPDATE mail_messages msg SET status = 'sent'
FROM accepted_drafts d
WHERE msg.workspace_id = d.workspace_id AND msg.mailbox_id = d.mailbox_id
  AND msg.conversation_id = d.conversation_id AND msg.provider_message_id = d.provider_message_id
  AND msg.direction = 'outbound' AND msg.status = 'queued' AND msg.error IS NULL;
