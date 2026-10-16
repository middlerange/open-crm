import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

import { serveFrontend } from "./node-frontend.js";
import type { AppEnv } from "./types.js";

test("Node serves the frontend and deep links while preserving API and asset failures", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".frontend-test-"));
  try {
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "index.html"), "<html>Orbit</html>");
    await writeFile(path.join(directory, "assets", "app.js"), "console.log('Orbit')");
    await mkdir(path.join(directory, "content-research"));
    await writeFile(path.join(directory, "content-research", "snapshot.json"), '{"private":true}');
    const app = new Hono<AppEnv>();
    app.get("/api/example", (context) => context.json({ ok: true }));
    serveFrontend(app, path.relative(process.cwd(), directory));
    const headers = { accept: "text/html" };
    assert.equal(await (await app.request("/", { headers })).text(), "<html>Orbit</html>");
    assert.equal(
      await (await app.request("/crm/accounts", { headers })).text(),
      "<html>Orbit</html>",
    );
    assert.match(await (await app.request("/assets/app.js")).text(), /console.log/);
    for (const pathname of [
      "/content-research/snapshot.json",
      "/%63ontent-research/snapshot.json",
      "/content-research%2fsnapshot.json",
    ]) {
      assert.equal((await app.request(pathname, { headers })).status, 404);
    }
    assert.equal(
      await (await app.request("/content-research", { headers })).text(),
      "<html>Orbit</html>",
    );
    assert.equal((await app.request("/assets/missing.js")).status, 404);
    assert.equal((await app.request("/api/missing", { headers })).status, 404);
    assert.equal((await app.request("/api", { headers })).status, 404);
    assert.equal((await app.request("/crm/accounts", { method: "POST" })).status, 404);
    assert.deepEqual(await (await app.request("/api/example")).json(), { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
