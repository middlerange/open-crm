import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const envFile = process.argv[2];
const envPath = path.resolve(root, envFile || ".env");

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith("#")) continue;
    const raw = match[2];
    values[match[1]] =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
  return values;
}

function origin(value, label) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTP(S) origin without credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must not include a path, query, or fragment.`);
  }
  return parsed.origin;
}

const fileEnv = envFile === "--env-only" ? {} : parseEnv(await readFile(envPath, "utf8"));
const env = { ...fileEnv, ...process.env };
const appOrigin = origin(env.APP_ORIGIN || "http://localhost:8787", "APP_ORIGIN");
const apiOrigin = origin(env.ORBIT_EXTENSION_API_ORIGIN || appOrigin, "ORBIT_EXTENSION_API_ORIGIN");
const output = `globalThis.ORBIT_GTM_CONFIG = Object.freeze(${JSON.stringify({ apiOrigin, appOrigin }, null, 2)});\n`;

const source = path.join(root, "chrome-extension");
const destination = path.join(root, ".release/extension");
await mkdir(destination, { recursive: true });
const files = [
  "background.js",
  "content-script.js",
  "content.css",
  "orbit-mark.svg",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js",
  "README.md",
  "Lucide-LICENSE",
];
await Promise.all(
  files.map((file) => copyFile(path.join(source, file), path.join(destination, file))),
);
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
manifest.host_permissions = [
  ...new Set(["https://www.linkedin.com/*", `${apiOrigin}/*`, `${appOrigin}/*`]),
];
await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(destination, "config.local.js"), output, { mode: 0o600 });
console.log(
  `Configured .release/extension for ${apiOrigin} (app: ${appOrigin}). Load that directory in Chrome.`,
);
