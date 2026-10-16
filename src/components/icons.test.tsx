import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "./icons";

test("replacement icons retain compact sizing and forward SVG accessibility and style props", () => {
  for (const [name, Icon] of Object.entries(icons)) {
    const defaults = renderToStaticMarkup(createElement(Icon));
    assert.match(defaults, /width="20"/, name);
    assert.match(defaults, /height="20"/, name);
    assert.match(defaults, /viewBox="-4 -4 32 32"/, name);
    assert.match(defaults, /stroke="currentColor"/, name);

    const labeled = renderToStaticMarkup(
      createElement(Icon, {
        size: 16,
        strokeWidth: 1.5,
        className: "status-icon",
        "aria-label": "Ready",
        role: "img",
        style: { color: "red" },
      }),
    );
    assert.match(labeled, /width="16"/, name);
    assert.match(labeled, /height="16"/, name);
    assert.match(labeled, /stroke-width="1.5"/, name);
    assert.match(labeled, /class="[^"]*status-icon[^"]*"/, name);
    assert.match(labeled, /aria-label="Ready"/, name);
    assert.match(labeled, /role="img"/, name);
    assert.match(labeled, /style="color:red"/, name);
    assert.doesNotMatch(labeled, /aria-hidden="true"/, name);

    const decorative = renderToStaticMarkup(createElement(Icon, { "aria-hidden": true }));
    assert.match(decorative, /aria-hidden="true"/, name);
  }
});

test("filled favorites and task statuses retain distinct visual meanings", () => {
  assert.match(renderToStaticMarkup(<icons.StarFilledIcon />), /fill="currentColor"/);
  assert.match(renderToStaticMarkup(<icons.StarOutlineIcon />), /fill="none"/);
  const states = [
    icons.LinearBacklogIcon,
    icons.LinearTodoIcon,
    icons.LinearInProgressIcon,
    icons.LinearInReviewIcon,
    icons.LinearDoneIcon,
    icons.LinearCanceledIcon,
  ].map((Icon) => renderToStaticMarkup(<Icon />).match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]);
  assert.equal(new Set(states).size, states.length, "every task state has distinct SVG geometry");
});
