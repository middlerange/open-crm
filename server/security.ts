import { createHash, randomBytes } from "node:crypto";

import { argon2id, argon2Verify } from "hash-wasm";

export async function hashPassword(password: string) {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  return argon2id({
    password,
    salt,
    memorySize: 19_456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: "encoded",
  });
}

export async function verifyPassword(passwordHash: string, password: string) {
  return argon2Verify({ hash: passwordHash, password });
}

export function createOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function normalizeDomain(value?: string | null) {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "") || null;
  } catch {
    return trimmed.replace(/^www\./, "").replace(/\/$/, "") || null;
  }
}

export function normalizeLinkedInUrl(value?: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/\/$/, "");
  }
}
