import assert from "node:assert/strict";
import test from "node:test";

import { app } from "./app";
import { configureRuntime } from "./config";

test("public widget configuration exposes only public fields and scopes its CSP", async () => {
  configureRuntime({ NODE_ENV: "test" });
  let response = await app.request("/api/public-config");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    features: { contentResearch: false },
    userorbit: null,
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.ok(!response.headers.get("Content-Security-Policy")!.includes("cdn.userorbit.com"));

  configureRuntime({
    NODE_ENV: "test",
    USERORBIT_ACCOUNT_ID: "public-account-id",
    USERORBIT_API_HOST: "https://widget-api.example.test",
    AGENT_API_TOKEN: "private-agent-token-never-exposed",
  });
  try {
    response = await app.request("/api/public-config");
    assert.deepEqual(await response.json(), {
      features: { contentResearch: false },
      userorbit: {
        accountId: "public-account-id",
        apiHost: "https://widget-api.example.test",
      },
    });
    const csp = response.headers.get("Content-Security-Policy")!;
    assert.match(csp, /script-src 'self' https:\/\/cdn.userorbit.com/);
    assert.match(csp, /connect-src 'self' https:\/\/widget-api.example.test/);
    assert.ok(!csp.includes("*"));
    assert.throws(() => configureRuntime({ USERORBIT_API_HOST: "javascript:alert(1)" }));
  } finally {
    configureRuntime(process.env);
  }
});

test("blank optional environment fields are absent but nonempty invalid credentials are rejected", () => {
  const optionalFields = [
    "DATABASE_URL",
    "USERORBIT_ACCOUNT_ID",
    "BOOTSTRAP_EMAIL",
    "BOOTSTRAP_PASSWORD",
    "BOOTSTRAP_NAME",
    "AGENT_API_TOKEN",
    "CLOUDFLARE_EMAIL_ACCOUNT_ID",
    "CLOUDFLARE_EMAIL_API_TOKEN",
    "MAIL_INGRESS_SECRET",
  ] as const;
  try {
    const parsed = configureRuntime(Object.fromEntries(optionalFields.map((key) => [key, ""])));
    for (const key of optionalFields) assert.equal(parsed[key], undefined);
    assert.throws(() => configureRuntime({ BOOTSTRAP_PASSWORD: "short" }));
    assert.throws(() => configureRuntime({ BOOTSTRAP_EMAIL: "invalid" }));
    assert.throws(() => configureRuntime({ AGENT_API_TOKEN: "short" }));
    assert.throws(() => configureRuntime({ MAIL_INGRESS_SECRET: "short" }));
    assert.throws(() => configureRuntime({ CLOUDFLARE_EMAIL_ACCOUNT_ID: "invalid" }));
  } finally {
    configureRuntime(process.env);
  }
});
