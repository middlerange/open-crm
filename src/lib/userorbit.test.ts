import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { syncUserorbit } from "./userorbit";
import type { CurrentUser } from "./auth";

test("Userorbit deduplicates renders and clears identity on workspace changes and logout", async () => {
  const calls: string[] = [];
  const configs: Array<Record<string, unknown>> = [];
  let finishInitialization!: () => void;
  const ready = new Promise<void>((resolve) => {
    finishInitialization = resolve;
  });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let widgetEnabled = false;
  globalThis.fetch = async (input) => {
    assert.equal(input, "/api/public-config");
    return Response.json({
      userorbit: widgetEnabled
        ? { accountId: "test-widget-account", apiHost: "https://widget.example.test" }
        : null,
    });
  };
  globalThis.window = {
    location: { pathname: "/" },
    userorbit: {
      async init(config: Record<string, unknown>) {
        configs.push(config);
        calls.push("init");
        await ready;
        calls.push("ready");
      },
      async registerRouteChange() {
        await ready;
        calls.push("route");
      },
      async logout() {
        calls.push("logout");
      },
    },
  } as unknown as Window & typeof globalThis;
  const user: CurrentUser = {
    id: "member-1",
    name: "Test member",
    email: "member@example.test",
    role: "ic",
    workspaceId: "workspace-1",
    workspaceName: "Test workspace",
    workspaceSlug: "test",
  };
  try {
    syncUserorbit(user);
    await setImmediate();
    assert.deepEqual(calls, [], "disabled deployments must never initialize the external SDK");
    syncUserorbit(null);
    widgetEnabled = true;
    syncUserorbit(user);
    syncUserorbit({ ...user });
    await setImmediate();
    assert.deepEqual(calls, ["init"]);
    syncUserorbit({ ...user, workspaceId: "workspace-2", workspaceName: "Second workspace" });
    await setImmediate();
    assert.deepEqual(calls, ["init"]);
    finishInitialization();
    await setImmediate();
    assert.deepEqual(calls, ["init", "ready", "route", "logout", "init", "ready", "route"]);
    assert.equal(configs[0]!.accountId, "test-widget-account");
    assert.equal(configs[0]!.apiHost, "https://widget.example.test");
    assert.equal(configs[0]!.userId, user.id);
    assert.equal(configs[0]!.email, user.email);
    assert.equal(configs[0]!.name, user.name);
    assert.deepEqual(configs[0]!.openOptions, {
      activeTabs: ["home", "feedback", "roadmap", "updates", "help"],
    });
    assert.deepEqual(configs[1]!.attributes, {
      "user.role": "ic",
      "user.company": "Second workspace",
      "workspace.id": "workspace-2",
    });
    syncUserorbit(null);
    syncUserorbit(null);
    await setImmediate();
    assert.equal(calls.filter((call) => call === "logout").length, 2);
    syncUserorbit({ ...user, id: "member-2" });
    await setImmediate();
    assert.equal(configs.at(-1)!.userId, "member-2");
    syncUserorbit(null);
    await setImmediate();
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
