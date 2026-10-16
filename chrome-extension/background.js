const DEFAULT_ORIGIN = "http://localhost:8787";

if (typeof importScripts === "function") {
  try {
    importScripts("config.local.js");
  } catch {
    // An unconfigured source checkout connects to the local application.
  }
}

function configuredOrigin(value, fallback) {
  try {
    const url = new URL(value || fallback);
    return url.origin;
  } catch {
    return fallback;
  }
}

const API_ORIGIN = configuredOrigin(globalThis.ORBIT_GTM_CONFIG?.apiOrigin, DEFAULT_ORIGIN);
const APP_ORIGIN = configuredOrigin(globalThis.ORBIT_GTM_CONFIG?.appOrigin, API_ORIGIN);
const CONNECTION_KEYS = ["apiToken", "tokenId", "userName", "workspaceName"];

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

void configureSidePanel().catch(() => undefined);
chrome.runtime.onInstalled?.addListener(() => {
  void configureSidePanel().catch(() => undefined);
});

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function storedConnection() {
  const stored = await chrome.storage.local.get(CONNECTION_KEYS);
  return stored.apiToken ? stored : null;
}

async function clearConnection() {
  await chrome.storage.local.remove(CONNECTION_KEYS);
}

async function authenticatedFetch(path, options = {}) {
  const connection = await storedConnection();
  if (!connection) return { ok: false, status: 401, error: "Orbit login required." };
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${connection.apiToken}`);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) await clearConnection();
    return response.ok
      ? { ok: true, status: response.status, data: payload }
      : {
          ok: false,
          status: response.status,
          error: payload.error || "Orbit rejected the request.",
        };
  } catch {
    return { ok: false, status: 0, error: "Could not reach Orbit." };
  }
}

async function validateConnection() {
  const connection = await storedConnection();
  if (!connection) return { connected: false };
  const result = await authenticatedFetch("/api/v1/linkedin/auth/me");
  if (!result.ok) return { connected: false, error: result.error };
  const next = {
    apiToken: connection.apiToken,
    tokenId: connection.tokenId,
    userName: result.data.user.name,
    workspaceName: result.data.user.workspaceName,
  };
  await chrome.storage.local.set(next);
  return { connected: true, ...next };
}

async function connect(interactive) {
  const existing = await validateConnection();
  if (existing.connected) return existing;

  const redirectUri = chrome.identity.getRedirectURL("orbit");
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(18);
  const authorizationUrl = new URL("/api/linkedin/authorize-browser", API_ORIGIN);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set(
    "token_label",
    `Chrome extension ${navigator.platform || "browser"}`,
  );

  let finalUrl;
  try {
    finalUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizationUrl.toString(),
      interactive,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 7_000,
    });
  } catch {
    return interactive
      ? { connected: false, error: "Orbit login was cancelled." }
      : { connected: false, needsLogin: true };
  }
  if (!finalUrl) return { connected: false, needsLogin: true };

  const callback = new URL(finalUrl);
  if (callback.searchParams.get("state") !== state) {
    return { connected: false, error: "The Orbit login response could not be verified." };
  }
  const code = callback.searchParams.get("code");
  if (!code) {
    return {
      connected: false,
      error: callback.searchParams.get("error") || "Orbit login failed.",
    };
  }

  try {
    const response = await fetch(`${API_ORIGIN}/api/v1/linkedin/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier, redirectUri }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { connected: false, error: payload.error || "Orbit login failed." };
    }
    const connection = {
      apiToken: payload.token,
      tokenId: payload.tokenId,
      userName: payload.user.name,
      workspaceName: payload.user.workspaceName,
    };
    await chrome.storage.local.set(connection);
    return { connected: true, ...connection };
  } catch {
    return { connected: false, error: "Could not reach Orbit." };
  }
}

async function disconnect() {
  await authenticatedFetch("/api/v1/linkedin/auth/session", { method: "DELETE" });
  await clearConnection();
  return { ok: true };
}

function selectedPostStorageKey(tabId) {
  return `selectedLinkedInPost:${tabId}`;
}

async function rememberSelectedPost(tabId, target) {
  if (!tabId || !target || !chrome.storage.session?.set) return;
  await chrome.storage.session.set({ [selectedPostStorageKey(tabId)]: target });
}

async function selectedPost(tabId) {
  if (!tabId || !chrome.storage.session?.get) return null;
  const key = selectedPostStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? null;
}

async function openSidePanel(tabId, target, autoCollect = false) {
  if (!tabId || !chrome.sidePanel?.open) {
    return { ok: false, error: "The Orbit side panel could not identify this LinkedIn tab." };
  }
  try {
    const openingPanel = chrome.sidePanel.open({ tabId });
    const rememberTarget = rememberSelectedPost(tabId, target);
    await openingPanel;
    void rememberTarget.catch(() => undefined);
    void Promise.resolve(
      chrome.runtime.sendMessage({
        type: "ORBIT_SIDE_PANEL_TARGET_CHANGED",
        tabId,
        autoCollect,
      }),
    ).catch(() => undefined);
    return { ok: true };
  } catch {
    return { ok: false, error: "Chrome could not open the Orbit side panel." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let operation;
  if (message?.type === "ORBIT_CONNECTION") operation = validateConnection();
  else if (message?.type === "ORBIT_CONNECT") operation = connect(Boolean(message.interactive));
  else if (message?.type === "ORBIT_DISCONNECT") operation = disconnect();
  else if (message?.type === "ORBIT_OPEN_QUEUE") {
    operation = chrome.tabs
      .create({ url: `${APP_ORIGIN}/social-leads` })
      .then(() => ({ ok: true }));
  } else if (message?.type === "ORBIT_API") {
    operation = authenticatedFetch(message.path, {
      method: message.method || "GET",
      body: message.body ? JSON.stringify(message.body) : undefined,
    });
  } else if (message?.type === "ORBIT_OPEN_SIDE_PANEL") {
    operation = openSidePanel(sender.tab?.id, message.target, Boolean(message.autoCollect));
  } else if (message?.type === "ORBIT_SELECTED_POST") {
    operation = selectedPost(message.tabId).then((target) => ({ ok: true, target }));
  } else return false;

  operation
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "Unexpected extension error." }));
  return true;
});
