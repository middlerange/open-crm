import argon2Wasm from "./argon2.wasm";
import type { ExecutionContext } from "@cloudflare/workers-types";
import blake2bWasm from "./blake2b.wasm";
import { app } from "../server/app.js";
import { configureRuntime } from "../server/config.js";
import { withDatabase } from "../server/db.js";
import { initializeDatabase } from "../server/database-setup.js";
import migrations from "./migrations.generated.json";
import { contentSecurityPolicy } from "../server/security-headers.js";
import { InvalidInboundMail, parseInboundMail, readInboundBody } from "../server/mail-ingress.js";
import { ingestMail } from "../server/mail-store.js";
import type { MailBinding } from "../server/mail-provider.js";

const originalCompile = WebAssembly.compile.bind(WebAssembly);
const wasmModules = new Map([
  ["argon2", argon2Wasm],
  ["blake2b", blake2bWasm],
]);

WebAssembly.compile = async (bytes: BufferSource) => {
  const length = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength;
  if (length === 6660) return wasmModules.get("argon2")!;
  if (length === 7442) return wasmModules.get("blake2b")!;
  return originalCompile(bytes);
};

type WorkerEnvironment = {
  HYPERDRIVE?: { connectionString: string };
  ASSETS: { fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  APP_ORIGIN?: string;
  ORBIT_REDIRECT_ORIGINS?: string;
  USERORBIT_ACCOUNT_ID?: string;
  USERORBIT_API_HOST?: string;
  DATABASE_SSL?: "require" | "disable";
  DATABASE_URL?: string;
  SESSION_COOKIE_NAME?: string;
  ORBIT_EXTENSION_IDS?: string;
  BOOTSTRAP_EMAIL?: string;
  BOOTSTRAP_PASSWORD?: string;
  BOOTSTRAP_NAME?: string;
  AGENT_API_TOKEN?: string;
  MAILER?: MailBinding;
  MAIL_DOMAINS?: string;
  MAIL_DOMAIN_WORKSPACES?: string;
  MAIL_INBOUND_ALIASES?: string;
  MAIL_SENDING_ENABLED?: "true" | "false";
  CLOUDFLARE_EMAIL_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
  MAIL_INGRESS_SECRET?: string;
};

function prepareRuntime(environment: WorkerEnvironment) {
  const databaseUrl = environment.HYPERDRIVE?.connectionString ?? environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("Configure DATABASE_URL or a HYPERDRIVE binding.");
  configureRuntime({
    ...environment,
    DATABASE_URL: databaseUrl,
    // Hyperdrive encrypts its origin connection; its Worker-side socket uses its own transport.
    DATABASE_SSL: environment.HYPERDRIVE ? "disable" : environment.DATABASE_SSL,
    NODE_ENV: "production",
  });
  return databaseUrl;
}

const initialized = new Map<string, Promise<void>>();
async function ensureReady(databaseUrl: string) {
  let ready = initialized.get(databaseUrl);
  if (!ready) {
    ready = initializeDatabase(migrations).catch((error) => {
      initialized.delete(databaseUrl);
      throw error;
    });
    initialized.set(databaseUrl, ready);
  }
  await ready;
}

export default {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
    executionContext: ExecutionContext,
  ) {
    const url = new URL(request.url);
    const appOrigin = environment.APP_ORIGIN ? new URL(environment.APP_ORIGIN).origin : url.origin;
    const redirectOrigins = (environment.ORBIT_REDIRECT_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim());
    if (redirectOrigins.includes(url.origin) && url.origin !== appOrigin) {
      return Response.redirect(`${appOrigin}${url.pathname}${url.search}`, 308);
    }
    if (
      !url.pathname.startsWith("/api/") &&
      url.pathname !== "/api" &&
      url.pathname !== "/health"
    ) {
      const asset = await environment.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set("Content-Security-Policy", contentSecurityPolicy(environment));
      response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("X-Frame-Options", "SAMEORIGIN");
      response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      return response;
    }
    try {
      const databaseUrl = prepareRuntime({ ...environment, APP_ORIGIN: appOrigin });
      return await withDatabase(databaseUrl, async () => {
        await ensureReady(databaseUrl);
        return app.fetch(request, environment, executionContext);
      });
    } catch {
      return Response.json(
        { error: "Orbit setup failed. Check database connectivity and bootstrap settings." },
        { status: 503 },
      );
    }
  },
  async email(
    message: {
      raw: ReadableStream<Uint8Array>;
      to: string;
      from: string;
      setReject(reason: string): void;
    },
    environment: WorkerEnvironment,
  ) {
    try {
      const databaseUrl = prepareRuntime(environment);
      const raw = await readInboundBody(message.raw);
      const input = await parseInboundMail(raw, message.to, message.from);
      const result = await withDatabase(databaseUrl, async () => {
        await ensureReady(databaseUrl);
        return ingestMail(input);
      });
      if (result.status === "unroutable")
        message.setReject("This mailbox does not exist or is disabled.");
    } catch (error) {
      if (error instanceof InvalidInboundMail) {
        message.setReject(error.message);
        return;
      }
      throw error;
    }
  },
};
