import assert from "node:assert/strict";
import test from "node:test";
import { deploymentConfig, readDeploymentBase } from "./cloudflare-config.mjs";
const base = await readDeploymentBase();

test("generic deployment has no private infrastructure and separates credentials", () => {
  const { config, secrets } = deploymentConfig(base, {
    ORBIT_WORKER_NAME: "team-crm",
    APP_ORIGIN: "https://crm.example.test",
    ORBIT_CUSTOM_DOMAINS: "crm.example.test",
    ORBIT_HYPERDRIVE_ID: "a".repeat(32),
    DATABASE_URL: "postgres://test:secret@example.test/orbit",
    BOOTSTRAP_PASSWORD: "a-test-password",
    MAIL_DOMAIN_WORKSPACES: '{"example.test":"orbit-gtm"}',
    UNRELATED_SECRET: "do-not-copy",
  });
  assert.equal(config.name, "team-crm");
  assert.equal(config.routes[0].pattern, "crm.example.test");
  assert.equal(config.hyperdrive[0].id, "a".repeat(32));
  assert.equal(config.vars.MAIL_SENDING_ENABLED, "false");
  assert.equal(config.vars.DATABASE_URL, undefined);
  assert.equal(config.vars.BOOTSTRAP_PASSWORD, undefined);
  assert.equal(config.send_email, undefined);
  assert.equal(secrets.BOOTSTRAP_PASSWORD, "a-test-password");
  assert.equal(secrets.UNRELATED_SECRET, undefined);
  assert.equal(base.routes, undefined);
  assert.equal(base.hyperdrive, undefined);
  assert.doesNotMatch(JSON.stringify(base), /userorb\.com|mukesh|mohamed|shayana/);
});

test("deployment rejects malformed origins and infrastructure identifiers", () => {
  for (const env of [
    { APP_ORIGIN: "https://crm.example.test/path" },
    { APP_ORIGIN: "http://crm.example.test" },
    { ORBIT_CUSTOM_DOMAINS: "https://crm.example.test" },
    { ORBIT_HYPERDRIVE_ID: "invalid" },
    { ORBIT_WORKER_NAME: "../bad" },
  ])
    assert.throws(() => deploymentConfig(base, env));
});

test("explicit empty public values clear prior deployment settings", () => {
  const { config } = deploymentConfig(base, {
    USERORBIT_ACCOUNT_ID: "",
    MAIL_DOMAINS: "",
    ORBIT_REDIRECT_ORIGINS: "",
    APP_ORIGIN: "",
  });
  assert.equal(config.vars.USERORBIT_ACCOUNT_ID, "");
  assert.equal(config.vars.MAIL_DOMAINS, "");
  assert.equal(config.vars.ORBIT_REDIRECT_ORIGINS, "");
  assert.equal(config.vars.APP_ORIGIN, "");
});
