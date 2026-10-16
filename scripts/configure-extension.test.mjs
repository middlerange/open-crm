import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./configure-extension.mjs", import.meta.url));
const source = fileURLToPath(new URL("../chrome-extension/", import.meta.url));

test("extension packaging scopes permissions and copies no private configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbit-extension-"));
  try {
    const sourceCopy = path.join(root, "chrome-extension");
    await mkdir(sourceCopy);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== "config.local.js") {
        await copyFile(path.join(source, entry.name), path.join(sourceCopy, entry.name));
      }
    }
    const originalManifest = await readFile(path.join(sourceCopy, "manifest.json"), "utf8");
    await writeFile(path.join(sourceCopy, "config.local.js"), "PRIVATE_OLD_CONFIG");
    await writeFile(
      path.join(root, "custom.env"),
      [
        "APP_ORIGIN=https://orbit.example.test",
        "ORBIT_EXTENSION_API_ORIGIN=https://api.example.test",
        "DATABASE_URL=PRIVATE_DATABASE_VALUE",
      ].join("\n"),
    );
    const env = { ...process.env };
    delete env.APP_ORIGIN;
    delete env.ORBIT_EXTENSION_API_ORIGIN;
    const run = (args, overrides = {}) =>
      execFileSync(process.execPath, [script, ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        stdio: "pipe",
      });
    run(["custom.env"]);
    const output = path.join(root, ".release/extension");
    assert.equal(
      await readFile(path.join(output, "Lucide-LICENSE"), "utf8"),
      await readFile(path.join(sourceCopy, "Lucide-LICENSE"), "utf8"),
      "standalone extension includes the complete third-party icon license",
    );
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.host_permissions, [
      "https://www.linkedin.com/*",
      "https://api.example.test/*",
      "https://orbit.example.test/*",
    ]);
    assert.equal(await readFile(path.join(sourceCopy, "manifest.json"), "utf8"), originalManifest);
    assert.equal(
      await readFile(path.join(sourceCopy, "config.local.js"), "utf8"),
      "PRIVATE_OLD_CONFIG",
    );
    for (const file of await readdir(output)) {
      assert.doesNotMatch(
        await readFile(path.join(output, file), "utf8"),
        /PRIVATE_DATABASE_VALUE|PRIVATE_OLD_CONFIG/,
      );
    }
    run(["--env-only"], { APP_ORIGIN: "https://second.example.test" });
    const configured = await readFile(path.join(output, "config.local.js"), "utf8");
    assert.match(configured, /"apiOrigin": "https:\/\/second.example.test"/);
    assert.match(configured, /"appOrigin": "https:\/\/second.example.test"/);
    assert.throws(() => run(["--env-only"], { APP_ORIGIN: "https://user:secret@example.test" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
