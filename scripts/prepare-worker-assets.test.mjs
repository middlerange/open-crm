import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("worker assets include private research only on opt-in and remove stale copies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbit-assets-test-"));
  const script = fileURLToPath(new URL("./prepare-worker-assets.mjs", import.meta.url));
  try {
    for (const name of [
      "migrations",
      "worker",
      "content-research",
      "node_modules/hash-wasm/dist",
    ]) {
      await mkdir(path.join(directory, name), { recursive: true });
    }
    await writeFile(
      path.join(directory, "content-research/example.md"),
      "synthetic private research",
    );
    await writeFile(path.join(directory, "migrations/001_test.sql"), "SELECT 1;");
    for (const name of ["argon2", "blake2b"]) {
      await writeFile(
        path.join(directory, `node_modules/hash-wasm/dist/${name}.umd.min.js`),
        'data:"dGVzdA=="',
      );
    }
    function prepare(include) {
      const result = spawnSync(process.execPath, [script], {
        cwd: directory,
        env: { ...process.env, ORBIT_INCLUDE_PRIVATE_RESEARCH: include },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    prepare("false");
    await assert.rejects(access(path.join(directory, "dist/content-research")));
    prepare("true");
    assert.equal(
      await readFile(path.join(directory, "dist/content-research/example.md"), "utf8"),
      "synthetic private research",
    );
    prepare("false");
    await assert.rejects(access(path.join(directory, "dist/content-research")));
    assert.equal(
      await readFile(path.join(directory, "content-research/example.md"), "utf8"),
      "synthetic private research",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
