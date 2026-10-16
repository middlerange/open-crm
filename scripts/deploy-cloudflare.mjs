import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { prepareDeployment } from "./cloudflare-config.mjs";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const dryRun = args.includes("--dry-run");
const envFile = args.find((argument) => !argument.startsWith("--"));
const { environment, hasSecrets } = await prepareDeployment(envFile);
function run(commandArgs) {
  const result = spawnSync("vp", commandArgs, { stdio: "inherit", env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Deployment step exited with status ${result.status}.`);
}
try {
  run(["run", "build:worker"]);
  const deployArgs = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.local.json",
    "--keep-vars",
  ];
  if (dryRun) deployArgs.push("--dry-run", "--outdir", ".release/worker");
  if (hasSecrets) deployArgs.push("--secrets-file", ".cloudflare-secrets.json");
  run(deployArgs);
} finally {
  await rm(".cloudflare-secrets.json", { force: true });
}
