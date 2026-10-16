import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.side_panel.default_path, "sidepanel.html");
assert.equal(manifest.action.default_popup, undefined);
assert.ok(manifest.permissions.includes("sidePanel"));
assert.ok(manifest.host_permissions.includes("https://www.linkedin.com/*"));
assert.ok(manifest.host_permissions.includes("http://localhost:8787/*"));
assert.equal(manifest.host_permissions.length, 2);

const storage = new Map();
const sessionStorage = new Map();
let runtimeListener;
let launchedAuthorizationUrl;
let exchangeRequest;
let createdTabUrl;
let openedSidePanelTabId;
let sidePanelBehavior;
let sidePanelMessage;
const panelEvents = [];

const expectedApiOrigin = process.env.ORBIT_TEST_API_ORIGIN || "http://localhost:8787";
const expectedAppOrigin = process.env.ORBIT_TEST_APP_ORIGIN || expectedApiOrigin;
if (process.env.ORBIT_TEST_API_ORIGIN) {
  globalThis.ORBIT_GTM_CONFIG = {
    apiOrigin: process.env.ORBIT_TEST_API_ORIGIN,
    appOrigin: process.env.ORBIT_TEST_APP_ORIGIN,
  };
}

globalThis.chrome = {
  identity: {
    getRedirectURL: () => "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/orbit",
    launchWebAuthFlow: async ({ url }) => {
      launchedAuthorizationUrl = new URL(url);
      const callback = new URL(chrome.identity.getRedirectURL());
      callback.searchParams.set("code", "test-authorization-code-123456789");
      callback.searchParams.set("state", launchedAuthorizationUrl.searchParams.get("state"));
      return callback.toString();
    },
  },
  runtime: {
    sendMessage: async (message) => {
      sidePanelMessage = message;
    },
    onInstalled: {
      addListener: () => undefined,
    },
    onMessage: {
      addListener: (listener) => {
        runtimeListener = listener;
      },
    },
  },
  sidePanel: {
    open: async ({ tabId }) => {
      panelEvents.push("open");
      openedSidePanelTabId = tabId;
    },
    setPanelBehavior: async (behavior) => {
      sidePanelBehavior = behavior;
    },
  },
  storage: {
    local: {
      get: async (keys) =>
        Object.fromEntries(
          keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]),
        ),
      remove: async (keys) => {
        for (const key of keys) storage.delete(key);
      },
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      },
    },
    session: {
      get: async (key) => (sessionStorage.has(key) ? { [key]: sessionStorage.get(key) } : {}),
      set: async (values) => {
        panelEvents.push("remember");
        for (const [key, value] of Object.entries(values)) sessionStorage.set(key, value);
      },
    },
  },
  tabs: {
    create: async ({ url }) => {
      createdTabUrl = url;
    },
  },
};

globalThis.fetch = async (url, options) => {
  exchangeRequest = { url: String(url), options };
  return new Response(
    JSON.stringify({
      token: "olt_test_token",
      tokenId: "test-token-id",
      user: { name: "Test User", workspaceName: "Test Workspace" },
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
};

await import("../background.js");

const result = await new Promise((resolve, reject) => {
  const keepsChannelOpen = runtimeListener(
    { type: "ORBIT_CONNECT", interactive: true },
    {},
    resolve,
  );
  if (!keepsChannelOpen) reject(new Error("The background listener closed before login finished."));
});

assert.equal(result.connected, true);
assert.equal(launchedAuthorizationUrl.origin, expectedApiOrigin);
assert.equal(launchedAuthorizationUrl.pathname, "/api/linkedin/authorize-browser");
assert.equal(
  launchedAuthorizationUrl.searchParams.get("redirect_uri"),
  chrome.identity.getRedirectURL(),
);
assert.match(launchedAuthorizationUrl.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
assert.match(launchedAuthorizationUrl.searchParams.get("state"), /^[A-Za-z0-9_-]{20,}$/);
assert.equal(exchangeRequest.url, `${expectedApiOrigin}/api/v1/linkedin/auth/exchange`);
assert.equal(
  JSON.parse(exchangeRequest.options.body).redirectUri,
  chrome.identity.getRedirectURL(),
);
assert.equal(storage.get("apiToken"), "olt_test_token");
assert.equal(storage.get("workspaceName"), "Test Workspace");

await new Promise((resolve, reject) => {
  const keepsChannelOpen = runtimeListener({ type: "ORBIT_OPEN_QUEUE" }, {}, resolve);
  if (!keepsChannelOpen) reject(new Error("The background listener closed before opening Orbit."));
});
assert.equal(createdTabUrl, `${expectedAppOrigin}/social-leads`);

const panelResult = await new Promise((resolve, reject) => {
  const target = {
    postKey: "urn:li:activity:999000111222333444",
    postAuthorName: "Canny",
    postText: "A selected LinkedIn post",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:999000111222333444",
  };
  const keepsChannelOpen = runtimeListener(
    { type: "ORBIT_OPEN_SIDE_PANEL", target, autoCollect: true },
    { tab: { id: 42 } },
    resolve,
  );
  if (!keepsChannelOpen) reject(new Error("The background listener closed before panel open."));
});
assert.equal(panelResult.ok, true);
assert.equal(openedSidePanelTabId, 42);
assert.deepEqual(panelEvents.slice(-2), ["open", "remember"]);
assert.deepEqual(sidePanelMessage, {
  type: "ORBIT_SIDE_PANEL_TARGET_CHANGED",
  tabId: 42,
  autoCollect: true,
});
const selectedPostResult = await new Promise((resolve, reject) => {
  const keepsChannelOpen = runtimeListener({ type: "ORBIT_SELECTED_POST", tabId: 42 }, {}, resolve);
  if (!keepsChannelOpen) reject(new Error("The background listener closed before target lookup."));
});
assert.equal(selectedPostResult.target.postAuthorName, "Canny");
assert.equal(selectedPostResult.target.postKey, "urn:li:activity:999000111222333444");
assert.deepEqual(sidePanelBehavior, { openPanelOnActionClick: true });

console.log("Extension authorization, storage, queue, and side-panel routing passed.");
