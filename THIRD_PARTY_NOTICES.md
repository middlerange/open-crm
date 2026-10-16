# Third-party notices

Orbit's original code is licensed under Apache License 2.0. Dependencies and bundled third-party material retain their own licenses; this license does not grant rights to third-party trademarks or hosted services.

## Lucide icons — ISC and MIT

The application uses `lucide-react`. Orbit's thin wrapper preserves its compact icon footprint and forwards accessibility attributes. The Chrome extension includes eight SVGs using Lucide geometry. Lucide includes Feather-derived material, so its full ISC and MIT notices are preserved in `licenses/Lucide-LICENSE` and `chrome-extension/Lucide-LICENSE`. The extension exporter includes that notice in every standalone package.

Upstream: [Lucide](https://github.com/lucide-icons/lucide). The exact dependency version is pinned in `pnpm-lock.yaml`.

## UI provenance

Previously vendored Campsite icon implementations have been removed. The copied theme and composite shadow definitions were replaced with newly authored CSS; the current shared React components were reviewed against the upstream source. The current release does not include the former Campsite UI code or license exception. See [UI provenance review](docs/UI_PROVENANCE.md) for scope, methods, and limitations.

## Other dependencies

React, Hono, PostgreSQL.js, hash-wasm, ExcelJS, the Userorbit SDK, and other dependencies retain the licenses shipped in their packages. Preserve those notices when distributing compiled artifacts. The Userorbit widget connects to an external service configured by the operator; access to that service is not granted by Orbit's source license.
