import { config } from "./config.js";

export type OutgoingMail = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  replyTo?: string;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: "attachment";
  }>;
  headers?: Record<string, string>;
};

export type MailBinding = {
  send(message: OutgoingMail): Promise<{ messageId: string }>;
};

export type MailSendResult = {
  messageId: string;
  status: "sent" | "queued" | "failed";
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
  suppressed: string[];
};

export class MailProviderError extends Error {
  constructor(
    message: string,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = "MailProviderError";
  }
}

export function mailProviderReady(binding?: MailBinding) {
  return (
    config.MAIL_SENDING_ENABLED === "true" &&
    Boolean(binding || (config.CLOUDFLARE_EMAIL_ACCOUNT_ID && config.CLOUDFLARE_EMAIL_API_TOKEN))
  );
}

export function mailDomains(workspaceSlug?: string) {
  const domains = [
    ...new Set(
      config.MAIL_DOMAINS.split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return workspaceSlug === undefined
    ? domains
    : domains.filter((domain) => config.MAIL_DOMAIN_WORKSPACES[domain] === workspaceSlug);
}

export async function sendMail(
  input: OutgoingMail,
  binding?: MailBinding,
): Promise<MailSendResult> {
  if (!mailProviderReady(binding)) {
    throw new MailProviderError(
      "Email sending is not configured. Ask your workspace administrator to finish email setup.",
    );
  }
  if (!mailDomains().includes(input.from.split("@")[1]?.toLowerCase())) {
    throw new MailProviderError("This sender domain is not enabled for email.");
  }
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
  if (
    !recipients.length ||
    recipients.length > 50 ||
    /[\r\n]/.test(input.subject) ||
    recipients.some((address) => /[\r\n]/.test(address))
  ) {
    throw new MailProviderError("Check the subject and recipients before sending.");
  }
  if (Object.keys(input.headers ?? {}).some((name) => /^(message-id|reply-to)$/i.test(name))) {
    throw new MailProviderError(
      "Use Cloudflare-generated message IDs and the dedicated reply address field.",
    );
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 5 * 1024 * 1024 - 16_384) {
    throw new MailProviderError("The message and attachments exceed the 5 MiB sending limit.");
  }
  if (binding) {
    try {
      const result = await binding.send(input);
      if (!result.messageId)
        throw new MailProviderError(
          "The provider did not confirm the send. Check email logs before sending again.",
          true,
        );
      // Sent means accepted by the provider, not confirmed recipient delivery.
      return {
        messageId: result.messageId,
        status: "sent",
        delivered: [],
        queued: [],
        permanentBounces: [],
        suppressed: [],
      };
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const rejected =
        /^E_(SENDER|RECIPIENT|SUBJECT|HEADER|HEADERS|BODY|ATTACHMENT|MESSAGE|RATE|QUOTA|SUPPRESS|AUTH|DOMAIN|TO_|FROM_|CONTENT|INVALID)/.test(
          code,
        );
      throw new MailProviderError(
        rejected
          ? "Cloudflare rejected this message. Check the sender domain, recipients, and sending limits."
          : "The provider did not confirm the send. Check email logs before sending again.",
        !rejected,
      );
    }
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_EMAIL_ACCOUNT_ID}/email/sending/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.CLOUDFLARE_EMAIL_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...input, replyTo: undefined, reply_to: input.replyTo }),
        signal: AbortSignal.timeout(25_000),
      },
    );
  } catch {
    throw new MailProviderError(
      "The provider did not confirm the send. Check email logs before sending again.",
      true,
    );
  }
  if (!response.ok) {
    const uncertain = response.status >= 500 || response.status === 408;
    throw new MailProviderError(
      uncertain
        ? "The provider did not confirm the send. Check email logs before sending again."
        : "Cloudflare rejected this message. Check email setup, recipients, and sending limits.",
      uncertain,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: {
      message_id?: string;
      messageId?: string;
      delivered?: string[];
      queued?: string[];
      permanent_bounces?: string[];
      suppressed_recipients?: string[];
    };
  } | null;
  if (!payload?.success || !payload.result) {
    throw new MailProviderError(
      "The provider did not confirm the send. Check email logs before sending again.",
      true,
    );
  }
  const result = payload.result;
  const delivered = result.delivered ?? [];
  const queued = result.queued ?? [];
  const permanentBounces = result.permanent_bounces ?? [];
  const suppressed = result.suppressed_recipients ?? [];
  const messageId = result.message_id ?? result.messageId ?? "";
  if (!delivered.length && !queued.length && !permanentBounces.length && !suppressed.length) {
    throw new MailProviderError(
      "The provider did not confirm the send. Check email logs before sending again.",
      true,
    );
  }
  return {
    messageId,
    status: delivered.length || queued.length ? "sent" : "failed",
    delivered,
    queued,
    permanentBounces,
    suppressed,
  };
}
