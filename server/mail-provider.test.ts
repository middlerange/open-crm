import assert from "node:assert/strict";
import test from "node:test";

import { configureRuntime } from "./config.js";
import { mailDomains, MailProviderError, mailProviderReady, sendMail } from "./mail-provider.js";

const input = {
  from: "me@mail.example.test",
  to: ["customer@example.test"],
  subject: "Hello",
  text: "A test message.",
};
const environment = {
  NODE_ENV: "test",
  MAIL_DOMAINS: "mail.example.test",
  MAIL_SENDING_ENABLED: "true",
  MAIL_DOMAIN_WORKSPACES: '{"mail.example.test":"sales"}',
  CLOUDFLARE_EMAIL_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_EMAIL_API_TOKEN: "test-only",
};

test("mail transport requires explicit enablement and isolates provisionable domains", async () => {
  configureRuntime({ ...environment, MAIL_SENDING_ENABLED: "false" });
  let called = false;
  const binding = {
    send: async () => {
      called = true;
      return { messageId: "test" };
    },
  };
  assert.equal(mailProviderReady(binding), false);
  await assert.rejects(sendMail(input, binding), /not configured/);
  assert.equal(called, false);
  assert.deepEqual(mailDomains("sales"), ["mail.example.test"]);
  assert.deepEqual(mailDomains("other-team"), []);
});

test("Worker acceptance is sent without claiming delivery, and unknown outcomes block retry", async () => {
  configureRuntime(environment);
  const result = await sendMail(input, { send: async () => ({ messageId: "<test@cloudflare>" }) });
  assert.equal(result.status, "sent");
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.queued, []);
  await assert.rejects(
    sendMail(input, {
      send: async () => {
        throw new Error("Connection lost");
      },
    }),
    (error) => error instanceof MailProviderError && error.uncertain,
  );
  await assert.rejects(
    sendMail(input, {
      send: async () => {
        throw Object.assign(new Error("Invalid sender"), { code: "E_SENDER_NOT_VERIFIED" });
      },
    }),
    (error) => error instanceof MailProviderError && !error.uncertain,
  );
});

test("REST acceptance is sent while retaining actual queued recipients and failures", async () => {
  configureRuntime(environment);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        success: true,
        result: {
          message_id: "accepted",
          queued: input.to,
          permanent_bounces: ["bad@example.test"],
          suppressed_recipients: ["suppressed@example.test"],
        },
      });
    const result = await sendMail(input);
    assert.equal(result.status, "sent");
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.queued, input.to);
    assert.deepEqual(result.permanentBounces, ["bad@example.test"]);
    assert.deepEqual(result.suppressed, ["suppressed@example.test"]);

    globalThis.fetch = async () =>
      Response.json({
        success: true,
        result: { message_id: "rejected", permanent_bounces: input.to },
      });
    assert.equal((await sendMail(input)).status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REST transport preserves partial delivery and treats server errors as uncertain without retry", async () => {
  configureRuntime(environment);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        success: true,
        result: {
          message_id: "test",
          delivered: input.to,
          queued: [],
          permanent_bounces: ["bad@example.test"],
        },
      });
    };
    const result = await sendMail(input);
    assert.equal(result.status, "sent");
    assert.deepEqual(result.permanentBounces, ["bad@example.test"]);
    globalThis.fetch = async () => {
      calls++;
      return new Response("Unavailable", { status: 503 });
    };
    await assert.rejects(
      sendMail(input),
      (error) => error instanceof MailProviderError && error.uncertain,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transport rejects unknown domains and header injection before network access", async () => {
  configureRuntime(environment);
  let called = false;
  const binding = {
    send: async () => {
      called = true;
      return { messageId: "test" };
    },
  };
  await assert.rejects(sendMail({ ...input, from: "someone@other.test" }, binding), /domain/);
  await assert.rejects(
    sendMail({ ...input, subject: "Hello\r\nBcc: other@example.test" }, binding),
    /subject/,
  );
  await assert.rejects(sendMail({ ...input, to: [] }, binding), /recipients/);
  assert.equal(called, false);
});
