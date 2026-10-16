import { parseEnv } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

export async function readDeploymentBase() {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const result = ts.parseConfigFileTextToJson("wrangler.jsonc", source);
  if (result.error) throw new Error("Invalid wrangler.jsonc configuration.");
  return result.config;
}

export const runtimeKeys = [
  "APP_ORIGIN",
  "SESSION_COOKIE_NAME",
  "ORBIT_REDIRECT_ORIGINS",
  "DATABASE_SSL",
  "USERORBIT_ACCOUNT_ID",
  "USERORBIT_API_HOST",
  "MAIL_DOMAINS",
  "MAIL_DOMAIN_WORKSPACES",
  "MAIL_INBOUND_ALIASES",
  "MAIL_SENDING_ENABLED",
  "CONTENT_RESEARCH_ENABLED",
];
export const secretKeys = [
  "DATABASE_URL",
  "BOOTSTRAP_EMAIL",
  "BOOTSTRAP_PASSWORD",
  "BOOTSTRAP_NAME",
  "AGENT_API_TOKEN",
  "CLOUDFLARE_EMAIL_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "MAIL_INGRESS_SECRET",
];

export function deploymentConfig(base, environment) {
  const config = structuredClone(base);
  if (environment.ORBIT_WORKER_NAME) config.name = environment.ORBIT_WORKER_NAME;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name)) throw new Error("Invalid ORBIT_WORKER_NAME.");
  config.vars = { ...config.vars };
  const clearable = new Set([
    "APP_ORIGIN",
    "USERORBIT_ACCOUNT_ID",
    "MAIL_DOMAINS",
    "ORBIT_REDIRECT_ORIGINS",
  ]);
  for (const key of runtimeKeys) {
    if (environment[key] !== undefined && (environment[key] !== "" || clearable.has(key)))
      config.vars[key] = environment[key];
  }
  if (config.vars.APP_ORIGIN) {
    const origin = new URL(config.vars.APP_ORIGIN);
    if (origin.protocol !== "https:" || origin.origin !== config.vars.APP_ORIGIN) {
      throw new Error("APP_ORIGIN must be an HTTPS origin without a path.");
    }
  }
  if (environment.ORBIT_CUSTOM_DOMAINS) {
    config.routes = environment.ORBIT_CUSTOM_DOMAINS.split(",").map((domain) => {
      domain = domain.trim();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))
        throw new Error("Invalid custom domain.");
      return { pattern: domain, custom_domain: true };
    });
  }
  if (environment.ORBIT_HYPERDRIVE_ID) {
    if (!/^[a-f0-9]{32}$/i.test(environment.ORBIT_HYPERDRIVE_ID))
      throw new Error("Invalid Hyperdrive ID.");
    config.hyperdrive = [{ binding: "HYPERDRIVE", id: environment.ORBIT_HYPERDRIVE_ID }];
  }
  if (environment.ORBIT_EMAIL_BINDING === "true") config.send_email = [{ name: "MAILER" }];
  const secrets = {};
  for (const key of secretKeys) if (environment[key]) secrets[key] = environment[key];
  return { config, secrets };
}

export async function prepareDeployment(envFile = ".env.cloudflare") {
  let fileEnvironment = {};
  try {
    fileEnvironment = parseEnv(await readFile(envFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || envFile !== ".env.cloudflare") throw error;
  }
  const environment = { ...fileEnvironment, ...process.env };
  const base = await readDeploymentBase();
  const { config, secrets } = deploymentConfig(base, environment);
  await writeFile("wrangler.local.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await writeFile(".cloudflare-secrets.json", JSON.stringify(secrets) + "\n", { mode: 0o600 });
  return { environment, hasSecrets: Object.keys(secrets).length > 0 };
}
