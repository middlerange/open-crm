export type MailboxKind = "private" | "shared";
export type MailFolder = "inbox" | "sent" | "drafts" | "archive";
export type MailDeliveryStatus =
  | "draft"
  | "sending"
  | "sent"
  | "queued"
  | "failed"
  | "uncertain"
  | "received";

export type Mailbox = {
  id: string;
  email: string;
  displayName: string;
  kind: MailboxKind;
  ownerId: string | null;
  ownerName: string | null;
  signature: string;
  replyTo: string | null;
  enabled: boolean;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MailSetup = {
  providerReady: boolean;
  configuredDomains: string[];
  canProvision: boolean;
  mailboxes: Mailbox[];
};

export type MailAddress = { name: string | null; email: string };

export type MailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  downloadUrl: string;
};

export type MailConversationSummary = {
  id: string;
  draftId: string | null;
  mailboxId: string;
  subject: string;
  participants: MailAddress[];
  preview: string;
  messageCount: number;
  lastMessageAt: string;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  draft: boolean;
  deliveryStatus: MailDeliveryStatus | null;
  accountId: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
};

export type MailMessage = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  status: MailDeliveryStatus;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  text: string;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  attachments: MailAttachment[];
  error: string | null;
};

export type MailConversation = MailConversationSummary & { messages: MailMessage[] };

export type MailDraftInput = {
  forwardMessageId?: string;
  mailboxId: string;
  conversationId?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  accountId?: string | null;
  contactId?: string | null;
};

export type MailDraft = {
  id: string;
  mailboxId: string;
  conversationId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  accountId: string | null;
  contactId: string | null;
  status: MailDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  attachments?: MailAttachment[];
};

export type MailConversationList = {
  conversations: MailConversationSummary[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
};

export type MailSendResult = {
  draft: MailDraft;
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
  suppressed: string[];
};
