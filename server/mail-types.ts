export type MailAddressInput = { name?: string | null; email: string };

export type InboundMailInput = {
  envelopeTo: string;
  providerMessageId?: string | null;
  internetMessageId: string;
  from: MailAddressInput;
  to: MailAddressInput[];
  cc?: MailAddressInput[];
  replyTo?: MailAddressInput[];
  subject?: string;
  text: string;
  headers?: Record<string, string>;
  inReplyTo?: string | null;
  references?: string[];
  receivedAt?: string | Date;
  attachments?: Array<{
    filename: string;
    contentType?: string;
    content: Uint8Array;
  }>;
};

export type InboundMailResult = {
  status: "ingested" | "duplicate" | "unroutable";
  messageId?: string;
  conversationId?: string;
  mailboxIds: string[];
};

export type MailProviderResult = {
  messageId: string;
  status: "sent" | "queued" | "failed";
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
  suppressed: string[];
};
