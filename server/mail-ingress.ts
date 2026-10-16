import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import PostalMime, { type Address } from "postal-mime";

import { config } from "./config.js";
import { ingestMail } from "./mail-store.js";

export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

export class InvalidInboundMail extends Error {}

const mailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveInboundEnvelopeRecipient(envelopeTo: string) {
  const normalized = envelopeTo.trim().toLowerCase();
  if (!mailAddressPattern.test(normalized))
    throw new InvalidInboundMail("Invalid envelope recipient.");
  const target = config.MAIL_INBOUND_ALIASES[normalized];
  if (target) return target;
  const domain = normalized.split("@")[1]!;
  const isAliasDomain = Object.keys(config.MAIL_INBOUND_ALIASES).some(
    (source) => source.split("@")[1] === domain,
  );
  if (isAliasDomain) throw new InvalidInboundMail("Unknown inbound alias.");
  return normalized;
}

function addresses(values: Address[] = []) {
  return values
    .flatMap((value) => value.group ?? [value])
    .filter((value) => value.address)
    .map((value) => ({ email: value.address!.trim().toLowerCase(), name: value.name || null }));
}

export function plainTextFromHtml(html: string) {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      const known: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      if (!entity.startsWith("#")) return known[entity.toLowerCase()] ?? match;
      const number =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseInboundMail(raw: Uint8Array, envelopeTo: string, envelopeFrom: string) {
  if (raw.byteLength > MAX_INBOUND_BYTES)
    throw new InvalidInboundMail("Message exceeds the 25 MiB inbox limit.");
  const resolvedEnvelopeTo = resolveInboundEnvelopeRecipient(envelopeTo);
  let parsed;
  try {
    parsed = await PostalMime.parse(raw, {
      maxNestingDepth: 30,
      maxHeadersSize: 128 * 1024,
      maxRfc822NestingDepth: 3,
    });
  } catch {
    throw new InvalidInboundMail("The message could not be parsed.");
  }
  const from = addresses(parsed.from ? [parsed.from] : [])[0] ?? {
    email: envelopeFrom.trim().toLowerCase(),
    name: null,
  };
  const headers: Record<string, string> = {};
  for (const key of [
    "message-id",
    "in-reply-to",
    "references",
    "reply-to",
    "authentication-results",
  ]) {
    const header = parsed.headers.find((entry) => entry.key === key);
    if (header) headers[key] = header.value.slice(0, 16_384);
  }
  const attachments = parsed.attachments.map((attachment) => ({
    filename: (attachment.filename || "attachment")
      .replace(/[\r\n/\\]/g, "_")
      .replaceAll(String.fromCharCode(0), "_")
      .slice(0, 255),
    contentType: attachment.mimeType,
    content:
      typeof attachment.content === "string"
        ? new Uint8Array(
            Buffer.from(attachment.content, attachment.encoding === "base64" ? "base64" : "utf8"),
          )
        : new Uint8Array(attachment.content),
  }));
  if (
    attachments.reduce((sum, attachment) => sum + attachment.content.byteLength, 0) >
    10 * 1024 * 1024
  ) {
    throw new InvalidInboundMail("Attachments exceed the 10 MiB inbox limit.");
  }
  return {
    envelopeTo: resolvedEnvelopeTo,
    internetMessageId:
      parsed.messageId?.trim() ||
      `<sha256-${createHash("sha256").update(raw).digest("hex")}@orbit.invalid>`,
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    subject: (parsed.subject || "(No subject)").slice(0, 998),
    text: parsed.text ?? plainTextFromHtml(parsed.html ?? ""),
    headers,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references?.match(/<[^>]+>/g)?.slice(-100) ?? [],
    receivedAt: new Date(),
    attachments,
  };
}

export async function readInboundBody(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INBOUND_BYTES) {
        await reader.cancel();
        throw new InvalidInboundMail("Message exceeds the 25 MiB inbox limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

// This bridge is for a Cloudflare Email Worker forwarding to the Node deployment.
// The main Cloudflare deployment calls ingestMail directly from its email handler.
export const mailIngressRoutes = new Hono();
mailIngressRoutes.post("/", async (context) => {
  const expected = config.MAIL_INGRESS_SECRET;
  const supplied = context.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (
    !expected ||
    !timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(expected).digest(),
    )
  ) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  if (!context.req.raw.body) return context.json({ error: "An email message is required." }, 400);
  try {
    const raw = await readInboundBody(context.req.raw.body);
    const input = await parseInboundMail(
      raw,
      context.req.header("x-envelope-to") ?? "",
      context.req.header("x-envelope-from") ?? "",
    );
    const result = await ingestMail(input);
    return context.json(result, result.status === "unroutable" ? 404 : 200);
  } catch (error) {
    if (error instanceof InvalidInboundMail) return context.json({ error: error.message }, 422);
    throw error;
  }
});
