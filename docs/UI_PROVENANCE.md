# UI provenance review

Completed October 16, 2026 for the public source export. This records source review and replacement evidence, not a legal guarantee or an audit of unpublished Git history.

## Replaced material

- Removed the complete 7,218-line vendored icon module. The 87 exports used by the app now wrap the `lucide-react` dependency; unused legacy implementations were removed.
- Replaced eight inline extension SVGs with Lucide geometry. Both the app and generated extension retain Lucide's ISC/MIT notices.
- Reauthored the light/dark semantic theme definitions and distinctive compound shadow stacks in the main stylesheet and extension styles. The replacement uses independently selected near-neutral colors and simpler original elevation rules.
- Removed instructions requiring exact Campsite token/path parity. Orbit's current design requirements are described in `docs/UI_DESIGN_SYSTEM.md`.

## Retained material and evidence

Reviewed 51 non-icon app TypeScript/React files against 1,652 upstream Campsite JavaScript/TypeScript files. Quote/whitespace-normalized contiguous-token screening found no match of 30 or more tokens. Manual inspection of shared primitives and representative navigation/workspace components found different implementations: Orbit uses its own native React state, portals, focus handling, and CSS classes rather than upstream command/popover infrastructure. No concrete copied expressive implementation was identified in those components, so they were retained rather than mechanically rewritten.

Compared all six app/extension CSS files with upstream app/UI CSS. After replacement, the scan found no contiguous match of three or more normalized statements. The audit also inspected the upstream theme configuration for the distinctive palette/shadow definitions. Functional layout dimensions, responsive rules, and ordinary CSS patterns were retained where no specific copied expression was identified. Match thresholds are screening aids; they cannot prove independent authorship or detect every translated implementation.

The user-selected Orbit brand mark was retained. Its embedded PNG did not match any of 371 upstream image/SVG assets. Earlier project records identify it as the existing Orbit favicon requested by the user; this comparison does not establish its complete ownership history.

## Verification

- All 87 icon exports render at their expected size with accessibility attributes and SVG overrides preserved. Filled favorites and six task-status glyphs remain distinct.
- A normalized long-path comparison found zero matches against 326 unique Campsite SVG paths in the current app and extension.
- Desktop (1440px) and mobile (390px) account tables and dialogs were compared in light/dark themes: identical shell/content dimensions, no page overflow, no browser errors, and working dialog open/Escape-close interactions.

## Distribution boundaries

Internal research, third-party reference code, old working notes, and private deployment artifacts are not part of this repository. Current source notices apply to the published code, not to any previous version that contained Campsite material.

Before publishing imported Git history, inspect that history separately. No Git metadata is present in this working directory.
