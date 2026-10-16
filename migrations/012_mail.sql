CREATE TABLE mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  normalized_email text NOT NULL,
  display_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('private', 'shared')),
  owner_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  signature text NOT NULL DEFAULT '',
  reply_to text,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'private' AND owner_id IS NOT NULL) OR (kind = 'shared' AND owner_id IS NULL))
);

CREATE UNIQUE INDEX mailboxes_email_unique_idx ON mailboxes(normalized_email);
CREATE INDEX mailboxes_workspace_idx ON mailboxes(workspace_id, kind, owner_id);

CREATE TABLE mail_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject text NOT NULL DEFAULT '',
  normalized_subject text NOT NULL DEFAULT '',
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mail_conversations_workspace_last_idx
  ON mail_conversations(workspace_id, last_message_at DESC);

CREATE TABLE mail_conversation_mailboxes (
  conversation_id uuid NOT NULL REFERENCES mail_conversations(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  unread boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, mailbox_id)
);

CREATE INDEX mail_conversation_mailboxes_folder_idx
  ON mail_conversation_mailboxes(mailbox_id, archived, unread, starred);

CREATE TABLE mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES mail_conversations(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'queued', 'failed', 'uncertain', 'received')),
  provider_message_id text,
  internet_message_id text,
  in_reply_to text,
  reference_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  sender jsonb NOT NULL,
  recipients_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipients_cc jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipients_bcc jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipients_reply_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL DEFAULT '',
  text_body text NOT NULL DEFAULT '',
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mail_messages_mailbox_provider_id_idx
  ON mail_messages(mailbox_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX mail_messages_mailbox_internet_id_idx
  ON mail_messages(mailbox_id, internet_message_id) WHERE internet_message_id IS NOT NULL;
CREATE INDEX mail_messages_conversation_idx ON mail_messages(conversation_id, created_at);

CREATE TABLE mail_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES mail_conversations(id) ON DELETE CASCADE,
  recipients_to text[] NOT NULL DEFAULT ARRAY[]::text[],
  recipients_cc text[] NOT NULL DEFAULT ARRAY[]::text[],
  recipients_bcc text[] NOT NULL DEFAULT ARRAY[]::text[],
  subject text NOT NULL DEFAULT '',
  text_body text NOT NULL DEFAULT '',
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'queued', 'failed', 'uncertain')),
  idempotency_key text,
  send_started_at timestamptz,
  send_completed_at timestamptz,
  provider_message_id text,
  delivery_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mail_drafts_mailbox_idx ON mail_drafts(mailbox_id, updated_at DESC);

CREATE TABLE mail_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid REFERENCES mail_messages(id) ON DELETE CASCADE,
  draft_id uuid REFERENCES mail_drafts(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  content bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((message_id IS NOT NULL)::int + (draft_id IS NOT NULL)::int = 1)
);

CREATE INDEX mail_attachments_message_idx ON mail_attachments(message_id);
CREATE INDEX mail_attachments_draft_idx ON mail_attachments(draft_id);

CREATE TRIGGER mailboxes_updated_at
  BEFORE UPDATE ON mailboxes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mail_conversations_updated_at
  BEFORE UPDATE ON mail_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mail_messages_updated_at
  BEFORE UPDATE ON mail_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mail_drafts_updated_at
  BEFORE UPDATE ON mail_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
