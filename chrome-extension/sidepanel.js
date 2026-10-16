// Icons: Lucide ISC/MIT, see Lucide-LICENSE.
const elements = {
  loading: document.querySelector("#loading"),
  setup: document.querySelector("#setup"),
  collector: document.querySelector("#collector"),
  connect: document.querySelector("#connect"),
  setupError: document.querySelector("#setup-error"),
  accountTrigger: document.querySelector("#account-trigger"),
  accountMenu: document.querySelector("#account-menu"),
  connectedUser: document.querySelector("#connected-user"),
  connectedWorkspace: document.querySelector("#connected-workspace"),
  postContext: document.querySelector("#post-context"),
  postAuthor: document.querySelector("#post-author"),
  postCopy: document.querySelector("#post-copy"),
  postStats: document.querySelector("#post-stats"),
  postReactions: document.querySelector("#post-reactions"),
  postComments: document.querySelector("#post-comments"),
  postReposts: document.querySelector("#post-reposts"),
  viewPost: document.querySelector("#view-post"),
  competitorName: document.querySelector("#competitor-name"),
  scan: document.querySelector("#scan"),
  scanLabel: document.querySelector(".scan-label"),
  scanModeTrigger: document.querySelector("#scan-mode-trigger"),
  scanModeMenu: document.querySelector("#scan-mode-menu"),
  scanModeOptions: [...document.querySelectorAll("[data-scan-mode]")],
  results: document.querySelector("#results"),
  resultCount: document.querySelector("#result-count"),
  resultBreakdown: document.querySelector("#result-breakdown"),
  warnings: document.querySelector("#warnings"),
  resultEmpty: document.querySelector("#result-empty"),
  clearFilters: document.querySelector("#clear-filters"),
  resultControls: document.querySelector("#result-controls"),
  search: document.querySelector("#search"),
  clearSearch: document.querySelector("#clear-search"),
  typeFilter: document.querySelector("#type-filter"),
  typeOptions: document.querySelector("#type-options"),
  typeOptionButtons: [...document.querySelectorAll("[data-type]")],
  selectionRow: document.querySelector(".selection-row"),
  selectedCount: document.querySelector("#selected-count"),
  toggleAll: document.querySelector("#toggle-all"),
  preview: document.querySelector("#preview"),
  loadMore: document.querySelector("#load-more"),
  resultActions: document.querySelector(".result-actions"),
  export: document.querySelector("#export"),
  save: document.querySelector("#save"),
  clear: document.querySelector("#clear"),
  status: document.querySelector("#status"),
  openQueue: document.querySelector("#open-queue"),
  reconnect: document.querySelector("#reconnect"),
  disconnect: document.querySelector("#disconnect"),
};

let scanResult = null;
let targetPostUrl = "";
let targetPostKey = "";
let selected = new Set();
let scanMode = "both";
let renderLimit = 100;

function cleanText(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function engagementKey(engagement) {
  return [
    engagement.profileUrl.toLowerCase(),
    engagement.engagementType,
    cleanText(engagement.commentText).toLowerCase(),
  ].join("|");
}

function deduplicate(engagements) {
  const unique = new Map();
  for (const engagement of engagements) {
    const key = engagementKey(engagement);
    if (!unique.has(key)) unique.set(key, engagement);
  }
  return [...unique.values()];
}

function showScreen(name) {
  elements.loading.hidden = name !== "loading";
  elements.setup.hidden = name !== "setup";
  elements.collector.hidden = name !== "collector";
  elements.accountTrigger.hidden = name !== "collector";
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setScanEnabled(enabled) {
  elements.scan.disabled = !enabled;
  elements.scanModeTrigger.disabled = !enabled;
}

function setBusy(control, busy) {
  control.setAttribute("aria-busy", String(busy));
}

function closeMenu(trigger, menu, restoreFocus = false) {
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

function openMenu(trigger, menu) {
  for (const [otherTrigger, otherMenu] of [
    [elements.accountTrigger, elements.accountMenu],
    [elements.scanModeTrigger, elements.scanModeMenu],
    [elements.typeFilter, elements.typeOptions],
  ]) {
    if (otherMenu !== menu) closeMenu(otherTrigger, otherMenu);
  }
  const rect = trigger.getBoundingClientRect();
  menu.hidden = false;
  const width = menu.offsetWidth || 200;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
  trigger.setAttribute("aria-expanded", "true");
}

function toggleMenu(trigger, menu) {
  if (menu.hidden) openMenu(trigger, menu);
  else closeMenu(trigger, menu, true);
}

function clearResults() {
  scanResult = null;
  selected = new Set();
  renderLimit = 100;
  elements.search.value = "";
  elements.clearSearch.hidden = true;
  elements.results.hidden = true;
}

function filteredEngagements() {
  const query = cleanText(elements.search.value).toLowerCase();
  const type = elements.typeFilter.dataset.value || "";
  return (scanResult?.engagements ?? []).filter((engagement) => {
    const haystack =
      `${engagement.personName} ${engagement.headline} ${engagement.commentText}`.toLowerCase();
    return (!query || haystack.includes(query)) && (!type || engagement.engagementType === type);
  });
}

function selectedEngagements() {
  return (scanResult?.engagements ?? []).filter((item) => selected.has(engagementKey(item)));
}

function renderUnavailable(message) {
  clearResults();
  targetPostUrl = "";
  targetPostKey = "";
  elements.postContext.classList.add("unavailable");
  elements.postAuthor.textContent = "Choose a LinkedIn post";
  elements.postCopy.textContent = message;
  elements.postStats.hidden = true;
  elements.viewPost.hidden = true;
  elements.viewPost.removeAttribute("href");
  setScanEnabled(false);
}

function renderPost(post) {
  const nextKey = post.postUrl || `${post.postAuthorName || ""}|${post.postText || ""}`;
  const changed = targetPostKey && targetPostKey !== nextKey;
  targetPostKey = nextKey;
  targetPostUrl = post.postUrl || "";
  if (changed) clearResults();
  elements.postContext.classList.remove("unavailable");
  elements.postAuthor.textContent = post.postAuthorName || "LinkedIn post";
  elements.postCopy.textContent = post.postText || "Capture visible engagement from this post.";
  elements.postReactions.textContent = `${post.postReactionCount || 0} reactions`;
  elements.postComments.textContent = `${post.postCommentCount || 0} comments`;
  elements.postReposts.textContent = `${post.postRepostCount || 0} reposts`;
  elements.postStats.hidden = false;
  elements.viewPost.hidden = !targetPostUrl;
  if (targetPostUrl) elements.viewPost.href = targetPostUrl;
  else elements.viewPost.removeAttribute("href");
  setScanEnabled(true);
  if (!elements.competitorName.value.trim() && post.postAuthorName) {
    elements.competitorName.value = post.postAuthorName;
  }
}

async function activeLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ? tab : null;
}

async function refreshTarget({ resetStatus = false, tabId = null } = {}) {
  const tab = tabId ? { id: tabId } : await activeLinkedInTab();
  if (!tab) {
    renderUnavailable("Open LinkedIn, then use the Orbit leads button beneath a post.");
    if (resetStatus) setStatus("");
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "ORBIT_LINKEDIN_CONTEXT" });
    if (!response?.ok) throw new Error(response?.error || "No LinkedIn post is visible.");
    renderPost(response.result);
    if (resetStatus) setStatus("");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read this LinkedIn tab.";
    const stored = await send({ type: "ORBIT_SELECTED_POST", tabId: tab.id }).catch(() => null);
    if (stored?.target) {
      renderPost(stored.target);
      setStatus(
        "Reload LinkedIn to scan this selected post with the latest Orbit extension.",
        true,
      );
      return;
    }
    renderUnavailable(
      message.includes("Receiving end")
        ? "Reload this LinkedIn tab once so Orbit can add its post buttons."
        : message,
    );
  }
}

function showConnection(connection) {
  elements.connectedUser.textContent = connection.userName || "Connected";
  elements.connectedWorkspace.textContent = connection.workspaceName || "Orbit";
  showScreen("collector");
}

async function connect(interactive) {
  showScreen("loading");
  elements.setupError.hidden = true;
  const result = await send({ type: "ORBIT_CONNECT", interactive }).catch(() => ({
    connected: false,
    error: "Could not start Orbit login.",
  }));
  if (result.connected) {
    showConnection(result);
    setStatus("Connected to Orbit.");
    await refreshTarget();
    return;
  }
  showScreen("setup");
  if (interactive && result.error) {
    elements.setupError.textContent = result.error;
    elements.setupError.hidden = false;
  }
}

async function load() {
  const stored = await chrome.storage.local.get(["competitorName", "scanMode"]);
  elements.competitorName.value = stored.competitorName ?? "";
  scanMode = ["both", "reactions", "comments"].includes(stored.scanMode) ? stored.scanMode : "both";
  for (const option of elements.scanModeOptions) {
    option.querySelector(".mode-check").textContent =
      option.dataset.scanMode === scanMode ? "✓" : "";
  }
  const connection = await send({ type: "ORBIT_CONNECTION" }).catch(() => ({ connected: false }));
  if (connection.connected) {
    showConnection(connection);
    await refreshTarget();
  } else {
    await connect(false);
  }
}

async function scan(mode) {
  setStatus("");
  setBusy(elements.collector, true);
  setScanEnabled(false);
  elements.scanLabel.textContent = "Collecting…";
  try {
    const tab = await activeLinkedInTab();
    if (!tab) throw new Error("Open LinkedIn in the active tab first.");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "ORBIT_SCAN_LINKEDIN", mode });
    if (!response?.ok) throw new Error(response?.error || "The post could not be scanned.");
    const previous = scanResult?.postUrl === response.result.postUrl ? scanResult.engagements : [];
    renderPost(response.result);
    scanResult = {
      ...response.result,
      engagements: deduplicate([...previous, ...response.result.engagements]),
    };
    for (const engagement of response.result.engagements) selected.add(engagementKey(engagement));
    renderResult();
    setStatus(
      response.result.engagements.length
        ? `${response.result.engagements.length} signal${response.result.engagements.length === 1 ? "" : "s"} collected. Review the selected people before saving.`
        : "LinkedIn returned no people for this post.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to scan this post.";
    setStatus(
      message.includes("Receiving end")
        ? "Reload this LinkedIn tab once, then scan again."
        : message,
      true,
    );
  } finally {
    setBusy(elements.collector, false);
    elements.scanLabel.textContent = "Collect engagement";
    setScanEnabled(Boolean(targetPostUrl || elements.postStats.hidden === false));
  }
}

function renderResult() {
  const focusedKey = document.activeElement?.dataset?.engagementKey || "";
  const engagements = scanResult?.engagements ?? [];
  const visible = filteredEngagements();
  const selectedRows = selectedEngagements();
  const reactions = engagements.filter((item) => item.engagementType === "reaction").length;
  const comments = engagements.length - reactions;
  elements.resultCount.textContent = `${engagements.length} ${engagements.length === 1 ? "person" : "people"}`;
  elements.resultBreakdown.textContent = `${reactions} reactions · ${comments} comments${visible.length > renderLimit ? ` · showing ${renderLimit} of ${visible.length}` : ""}`;
  const warningText = (scanResult?.warnings ?? []).join(" ");
  if (elements.warnings.textContent !== warningText) elements.warnings.textContent = warningText;
  elements.warnings.hidden = !elements.warnings.textContent;
  elements.selectedCount.textContent = `${selectedRows.length} selected`;
  elements.toggleAll.textContent =
    visible.length && visible.every((item) => selected.has(engagementKey(item)))
      ? "Clear visible"
      : "Select visible";
  const hasResults = engagements.length > 0;
  const hasVisible = visible.length > 0;
  elements.resultControls.hidden = !hasResults;
  elements.resultEmpty.hidden = hasVisible;
  elements.resultEmpty.querySelector("strong").textContent = hasResults
    ? "No people match these filters"
    : "No people found";
  elements.resultEmpty.querySelector("span").textContent = hasResults
    ? "Clear the search or choose another signal type."
    : "Open the post in its own page and try collecting again.";
  elements.clearFilters.hidden = !hasResults;
  elements.selectionRow.hidden = !hasVisible;
  elements.preview.hidden = !hasVisible;
  elements.resultActions.hidden = !hasVisible;
  elements.preview.replaceChildren(
    ...visible.slice(0, renderLimit).map((engagement) => {
      const row = document.createElement("div");
      row.className = "person";
      row.setAttribute("role", "listitem");
      const checkboxControl = document.createElement("label");
      checkboxControl.className = "select-control";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.engagementKey = engagementKey(engagement);
      checkbox.checked = selected.has(engagementKey(engagement));
      checkbox.setAttribute("aria-label", `Select ${engagement.personName}`);
      checkbox.addEventListener("change", () => {
        const key = engagementKey(engagement);
        if (checkbox.checked) selected.add(key);
        else selected.delete(key);
        renderResult();
      });
      checkboxControl.append(checkbox);
      const badge = document.createElement("span");
      badge.className = "person-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML =
        engagement.engagementType === "comment"
          ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"></path></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path><path d="M7 10v12"></path></svg>';
      const copy = document.createElement("div");
      const name = document.createElement("a");
      name.textContent = engagement.personName;
      name.href = engagement.profileUrl;
      name.target = "_blank";
      name.rel = "noreferrer";
      const detail = document.createElement("span");
      detail.textContent = engagement.commentText || engagement.headline || engagement.reactionType;
      copy.append(name, detail);
      row.append(checkboxControl, badge, copy);
      return row;
    }),
  );
  if (focusedKey) {
    elements.preview.querySelector(`[data-engagement-key="${CSS.escape(focusedKey)}"]`)?.focus();
  }
  elements.loadMore.hidden = !hasVisible || visible.length <= renderLimit;
  elements.save.disabled = selectedRows.length === 0 || !scanResult?.postUrl;
  elements.export.disabled = selectedRows.length === 0;
  elements.results.hidden = false;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  const rows = selectedEngagements();
  if (!rows.length || !scanResult) return;
  const source = elements.competitorName.value.trim();
  const headings = [
    "name",
    "profile_url",
    "headline",
    "location",
    "connection_degree",
    "engagement_type",
    "reaction_type",
    "comment",
    "source",
    "post_author",
    "post_url",
  ];
  const lines = [
    headings.map(csvCell).join(","),
    ...rows.map((item) =>
      [
        item.personName,
        item.profileUrl,
        item.headline,
        item.location,
        item.connectionDegree,
        item.engagementType,
        item.reactionType,
        item.commentText,
        source,
        scanResult.postAuthorName,
        scanResult.postUrl,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  const url = URL.createObjectURL(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `orbit-linkedin-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function save() {
  const engagements = selectedEngagements();
  if (!engagements.length || !scanResult) return;
  elements.save.disabled = true;
  setBusy(elements.save, true);
  elements.save.textContent = "Saving…";
  const competitorName = elements.competitorName.value.trim();
  await chrome.storage.local.set({ competitorName });
  const result = await send({
    type: "ORBIT_API",
    path: "/api/v1/linkedin/engagements",
    method: "POST",
    body: {
      ...scanResult,
      engagements,
      competitorName,
      capturedAt: new Date().toISOString(),
    },
  }).catch(() => ({ ok: false, error: "Could not reach Orbit." }));
  if (result.ok) {
    const { accepted, duplicates } = result.data;
    setStatus(
      `Saved ${accepted} new signal${accepted === 1 ? "" : "s"}; skipped ${duplicates} duplicate${duplicates === 1 ? "" : "s"}.`,
    );
    clearResults();
  } else if (result.status === 401) {
    showScreen("collector");
    setStatus(
      "Your Orbit session expired. Reconnect from the account menu to keep this review.",
      true,
    );
    openMenu(elements.accountTrigger, elements.accountMenu);
  } else {
    setStatus(result.error || "Unable to save these people.", true);
  }
  elements.save.disabled = false;
  setBusy(elements.save, false);
  elements.save.textContent = "Save selected to Orbit";
}

elements.connect.addEventListener("click", () => void connect(true));
elements.scan.addEventListener("click", () => void scan(scanMode));
elements.scanModeTrigger.addEventListener("click", () =>
  toggleMenu(elements.scanModeTrigger, elements.scanModeMenu),
);
for (const button of elements.scanModeOptions) {
  button.addEventListener("click", async () => {
    scanMode = button.dataset.scanMode;
    for (const option of elements.scanModeOptions) {
      option.querySelector(".mode-check").textContent = option === button ? "✓" : "";
    }
    await chrome.storage.local.set({ scanMode });
    closeMenu(elements.scanModeTrigger, elements.scanModeMenu, true);
  });
}
elements.save.addEventListener("click", () => void save());
elements.clear.addEventListener("click", () => {
  clearResults();
  setStatus("");
});
elements.search.addEventListener("input", () => {
  renderLimit = 100;
  elements.clearSearch.hidden = !elements.search.value;
  renderResult();
});
elements.search.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (elements.search.value) {
    elements.search.value = "";
    elements.clearSearch.hidden = true;
    renderResult();
  } else {
    elements.search.blur();
  }
});
elements.clearSearch.addEventListener("click", () => {
  elements.search.value = "";
  elements.clearSearch.hidden = true;
  elements.search.focus();
  renderResult();
});
elements.clearFilters.addEventListener("click", () => {
  elements.search.value = "";
  elements.clearSearch.hidden = true;
  const allOption = elements.typeOptionButtons.find((option) => option.dataset.type === "");
  allOption?.click();
});
elements.typeFilter.addEventListener("click", () =>
  toggleMenu(elements.typeFilter, elements.typeOptions),
);
for (const option of elements.typeOptionButtons) {
  option.addEventListener("click", () => {
    const value = option.dataset.type;
    elements.typeFilter.dataset.value = value;
    elements.typeFilter.querySelector("span").textContent =
      option.querySelector("span").textContent;
    for (const candidate of elements.typeOptionButtons) {
      const selectedOption = candidate === option;
      candidate.setAttribute("aria-selected", String(selectedOption));
      candidate.lastElementChild.textContent = selectedOption ? "✓" : "";
    }
    renderLimit = 100;
    closeMenu(elements.typeFilter, elements.typeOptions, true);
    renderResult();
  });
}
elements.toggleAll.addEventListener("click", () => {
  const visible = filteredEngagements();
  const allSelected = visible.length && visible.every((item) => selected.has(engagementKey(item)));
  for (const engagement of visible) {
    const key = engagementKey(engagement);
    if (allSelected) selected.delete(key);
    else selected.add(key);
  }
  renderResult();
});
elements.export.addEventListener("click", exportCsv);
elements.loadMore.addEventListener("click", () => {
  renderLimit += 100;
  renderResult();
});
elements.accountTrigger.addEventListener("click", () =>
  toggleMenu(elements.accountTrigger, elements.accountMenu),
);
elements.openQueue.addEventListener("click", () => {
  closeMenu(elements.accountTrigger, elements.accountMenu);
  void send({ type: "ORBIT_OPEN_QUEUE" });
});
elements.reconnect.addEventListener("click", () => {
  closeMenu(elements.accountTrigger, elements.accountMenu);
  void connect(true);
});
elements.disconnect.addEventListener("click", async () => {
  closeMenu(elements.accountTrigger, elements.accountMenu);
  await send({ type: "ORBIT_DISCONNECT" }).catch(() => undefined);
  showScreen("setup");
});

for (const trigger of [elements.accountTrigger, elements.scanModeTrigger, elements.typeFilter]) {
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const menu =
      trigger === elements.accountTrigger
        ? elements.accountMenu
        : trigger === elements.scanModeTrigger
          ? elements.scanModeMenu
          : elements.typeOptions;
    openMenu(trigger, menu);
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
  });
}

for (const menu of [elements.accountMenu, elements.scanModeMenu, elements.typeOptions]) {
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    const current = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[
        (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
      ]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  });
}

document.addEventListener("pointerdown", (event) => {
  for (const [trigger, menu] of [
    [elements.accountTrigger, elements.accountMenu],
    [elements.scanModeTrigger, elements.scanModeMenu],
    [elements.typeFilter, elements.typeOptions],
  ]) {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) {
      closeMenu(trigger, menu);
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const [trigger, menu] of [
    [elements.accountTrigger, elements.accountMenu],
    [elements.scanModeTrigger, elements.scanModeMenu],
    [elements.typeFilter, elements.typeOptions],
  ]) {
    if (!menu.hidden) closeMenu(trigger, menu, true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "ORBIT_SIDE_PANEL_TARGET_CHANGED") return false;
  void refreshTarget({ resetStatus: true, tabId: message.tabId }).then(() => {
    if (message.autoCollect) return scan(scanMode);
    return undefined;
  });
  return false;
});

chrome.tabs.onActivated.addListener(() => {
  clearResults();
  void refreshTarget({ resetStatus: true });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  clearResults();
  void refreshTarget({ resetStatus: true });
});

void load();
