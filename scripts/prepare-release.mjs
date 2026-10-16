import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = path.resolve(".release/source");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const entries = [
  "src",
  "server",
  "worker",
  "migrations",
  "public",
  "licenses",
  ".github",
  "chrome-extension",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "wrangler.jsonc",
  "Dockerfile",
  "compose.yml",
  ".dockerignore",
  ".gitignore",
  ".env.example",
  ".env.cloudflare.example",
  ".dev.vars.example",
  "AGENTS.md",
  "README.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/DEPLOYMENT.md",
  "docs/RELEASE_READINESS.md",
  "docs/UI_PROVENANCE.md",
  "docs/UI_DESIGN_SYSTEM.md",
  "scripts/cloudflare-build.sh",
  "scripts/cloudflare-config.mjs",
  "scripts/cloudflare-config.test.mjs",
  "scripts/deploy-cloudflare.mjs",
  "scripts/prepare-worker-assets.mjs",
  "scripts/prepare-worker-assets.test.mjs",
  "scripts/configure-extension.mjs",
  "scripts/configure-extension.test.mjs",
  "scripts/create-agent-api-key.ts",
  "scripts/prepare-release.mjs",
];
for (const entry of entries) {
  await mkdir(path.dirname(path.join(destination, entry)), { recursive: true });
  await cp(entry, path.join(destination, entry), {
    recursive: true,
    filter: (source) =>
      !["config.local.js", "argon2.wasm", "blake2b.wasm", "migrations.generated.json"].includes(
        path.basename(source),
      ),
  });
}
const packageFile = path.join(destination, "package.json");
const pkg = JSON.parse(await readFile(packageFile, "utf8"));
delete pkg.scripts["content:sync"];
await writeFile(packageFile, JSON.stringify(pkg, null, 2) + "\n");
const repository = process.env.ORBIT_PUBLIC_REPOSITORY_URL;
if (repository) {
  const url = new URL(repository);
  if (
    !["github.com", "gitlab.com"].includes(url.hostname) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.split("/").filter(Boolean).length < 2
  ) {
    throw new Error("ORBIT_PUBLIC_REPOSITORY_URL must be an HTTPS GitHub/GitLab repository URL.");
  }
  const readme = path.join(destination, "README.md");
  const button = `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(url.href)})`;
  await writeFile(
    readme,
    (await readFile(readme, "utf8")).replace(
      /<!-- DEPLOY_BUTTON -->[\s\S]*?<!-- \/DEPLOY_BUTTON -->/,
      `<!-- DEPLOY_BUTTON -->\n${button}\n<!-- /DEPLOY_BUTTON -->`,
    ),
  );
}
console.log(
  "Prepared .release/source with third-party notices. No repository or deployment was changed.",
);
