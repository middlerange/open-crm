import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { contentSecurityPolicy } from "./security-headers.js";

import { agentRoutes } from "./agent-routes.js";
import { agentKeyRoutes } from "./agent-key-routes.js";
import { authRoutes } from "./auth-routes.js";
import { config } from "./config.js";
import { crmConfigRoutes } from "./crm-config-routes.js";
import { crmEnhancementsRoutes } from "./crm-enhancements-routes.js";
import { crmRoutes } from "./crm-routes.js";
import { sql } from "./db.js";
import { databaseClientError } from "./http.js";
import { linkedinRoutes } from "./linkedin-routes.js";
import { mailRoutes } from "./mail-routes.js";
import { mailIngressRoutes } from "./mail-ingress.js";
import type { AppEnv } from "./types.js";
import { workRoutes } from "./work-routes.js";
import { workspaceRoutes } from "./workspace-routes.js";

export const app = new Hono<AppEnv>();

app.use("*", (context, next) => {
  context.header("Content-Security-Policy", contentSecurityPolicy(config));
  return secureHeaders({ crossOriginResourcePolicy: "same-origin" })(context, next);
});

app.use(
  "/api/v1/linkedin/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 86_400,
  }),
);

app.use("/api/*", async (context, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
    const origin = context.req.header("origin");
    const isExtensionApi =
      context.req.path.startsWith("/api/v1/linkedin/") &&
      (context.req.path === "/api/v1/linkedin/auth/exchange" ||
        context.req.header("authorization")?.startsWith("Bearer "));
    if (origin && origin !== config.APP_ORIGIN && !isExtensionApi) {
      return context.json({ error: "Request origin is not allowed." }, 403);
    }
  }
  await next();
});

app.get("/health", async (context) => {
  try {
    await sql`SELECT 1`;
    return context.json({ status: "ok", service: "orbit-gtm" });
  } catch (error) {
    console.error("Health check failed:", error instanceof Error ? error.message : error);
    return context.json({ status: "unhealthy", service: "orbit-gtm" }, 503);
  }
});

app.get("/api/health", async (context) => {
  await sql`SELECT 1`;
  return context.json({ status: "ok" });
});

app.get("/api/public-config", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json({
    userorbit: config.USERORBIT_ACCOUNT_ID
      ? { accountId: config.USERORBIT_ACCOUNT_ID, apiHost: config.USERORBIT_API_HOST }
      : null,
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/mail/ingress", mailIngressRoutes);
app.route("/api/mail", mailRoutes);
app.route("/api/agent-keys", agentKeyRoutes);
app.route("/api/v1/agent", agentRoutes);
app.route("/api", linkedinRoutes);
app.route("/api", workspaceRoutes);
app.route("/api", crmRoutes);
app.route("/api", crmEnhancementsRoutes);
app.route("/api", crmConfigRoutes);
app.route("/api", workRoutes);

app.notFound((context) => context.json({ error: "Not found." }, 404));
app.onError((error, context) => {
  const clientError = databaseClientError(context, error);
  if (clientError) return clientError;
  console.error("Unhandled request error:", error.message);
  return context.json({ error: "Unexpected server error." }, 500);
});
