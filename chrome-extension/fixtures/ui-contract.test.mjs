import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, panelScript, contentScript, contentStyles] = await Promise.all([
  readFile(new URL("../sidepanel.html", import.meta.url), "utf8"),
  readFile(new URL("../sidepanel.js", import.meta.url), "utf8"),
  readFile(new URL("../content-script.js", import.meta.url), "utf8"),
  readFile(new URL("../content.css", import.meta.url), "utf8"),
]);

assert.doesNotMatch(html, /<select\b/i, "the side panel must not use a native select");
assert.match(html, /id="type-filter"[^>]+role="combobox"/, "signal filtering uses a combobox");
assert.match(html, /id="scan"/, "the side panel exposes one primary scan action");
assert.match(html, /Collect engagement/, "the primary action communicates direct collection");
assert.match(html, /data-scan-mode="both"/, "scan variants live in the scan menu");
assert.match(html, /id="result-empty"/, "zero-result feedback is explicit");
assert.match(html, /id="load-more"/, "large result sets are not silently truncated");
assert.match(html, /id="account-menu"/, "account and disconnect actions live in the header menu");

assert.match(
  panelScript,
  /let renderLimit = 100/,
  "result rendering has an explicit visible limit",
);
assert.match(panelScript, /renderLimit \+= 100/, "the result limit can be expanded");
assert.match(panelScript, /Your Orbit session expired/, "expired sessions retain review context");
assert.match(panelScript, /dataset\?\.engagementKey/, "checkbox focus is restored after selection");
assert.doesNotMatch(
  panelScript,
  /visible signal/,
  "results are not described as visible-only scans",
);

assert.match(contentScript, /let activeButton = null/, "only one post trigger can be active");
assert.match(contentScript, /aria-pressed/, "post selection is exposed accessibly");
assert.match(
  contentScript,
  /async function collectAllReactions/,
  "reactors are progressively collected from LinkedIn after the user action",
);
assert.match(
  contentScript,
  /async function collectAllComments/,
  "comment pagination is collected after the user action",
);
assert.match(
  contentScript,
  /scrollTop = scroller\.scrollHeight/,
  "the reactions dialog advances without manual scrolling",
);
assert.match(contentScript, /autoCollect: true/, "Find leads starts collection in one user action");
assert.match(
  contentScript,
  /querySelectorAll\('dialog, \[role="dialog"\], \.artdeco-modal'\)/,
  "native LinkedIn dialogs are recognized",
);
assert.match(
  contentScript,
  /mountAnchor\.append\(hook\)/,
  "the trigger joins LinkedIn's action row",
);
assert.match(contentStyles, /\.orbit-lead-hook[\s\S]*width: auto/, "the injected hook is compact");

console.log("Extension UI contract passed.");
