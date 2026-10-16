# Release readiness

Reviewed October 16, 2026. The clean source is published at https://github.com/middlerange/open-crm. The initial GitHub Verify workflow passed, including isolated PostgreSQL installation, CRM, role-boundary, mail, and security suites.

## Implemented

- Generic Cloudflare configuration with environment-driven Worker name, domains, redirects, mailbox mappings, Hyperdrive, and Userorbit account.
- Separate allowlists for runtime values and secrets, ignored private configuration, and dry-run deployment command.
- Bundled SQL migrations and automatic first-request founder bootstrap; concurrent setup uses transaction-scoped PostgreSQL table locks.
- Configurable Userorbit widget retained, with runtime public configuration and scoped content-security policy.
- PostgreSQL-backed authentication throttling, including invitation password verification.
- Internal research omitted by default, role-protected when explicitly enabled, and excluded from source exports.
- Node frontend/deep-link serving and explicit local PostgreSQL TLS configuration.
- Configurable extension packaging with only the selected origins in its permissions.
- Apache 2.0 for original contributions; former noncommercial UI material replaced with Lucide icons and original CSS, with ISC/MIT notices retained.
- Contribution/security documentation, CI verification workflow, and allowlisted source exporter.

## Verified locally

- Production frontend and Node builds, TypeScript, formatting and lint.
- Clean exported source installed from the frozen lockfile, built and typechecked independently; 26 unit tests and 5 deployment tests passed. Exported Worker dry-run bundled successfully.
- Allowlisted source scan found no private paths or credential-pattern matches; this is not a historical Git secret audit.
- Unit, deployment configuration, extension packaging/auth/UI, and research asset isolation checks.
- Permissive UI replacements: desktop/mobile account tables and dialogs in light/dark themes retain shell geometry; extension setup renders in both themes without overflow or browser errors.
- Disposable PostgreSQL tests for CRM ownership, import/export, agent permissions, mail isolation, workspace switching, and rate limits.
- Fresh Node startup, all migrations, founder login/session, health, frontend and browser deep links.
- Fresh local Cloudflare Worker startup with eight concurrent initial requests, migrations, founder login/session, frontend and API errors.
- Concurrent database initialization regression: one workspace, one founder, no duplicate stages/tasks.

## Remaining gates

1. **Public repository and deploy-button verification:** the button targets `https://github.com/middlerange/open-crm`. The source and license notices are published. Test the complete deploy-button dashboard flow in a separate Cloudflare account. A CLI dry run does not verify that hosted onboarding flow.
2. **Docker execution:** Compose configuration and native Node installation were verified; image build/run was not possible without a running Docker daemon.
3. **Publication secret/history scan:** the public repository began with a reviewed clean export and no imported history. Its initial source scan found no credentials or private deployment/research data. Enable secret scanning and confirm a working private security-reporting channel; re-scan any history imported later.
4. **Third-party dependency provenance:** installed dependencies retain their own licenses. Review dependency notices for the exact distributed artifact; adding an Apache license does not grant rights to third-party code.

Cloudflare Email domain verification and PostgreSQL provisioning are operator setup steps. The basic app does not require email, and sending remains disabled by default. Deployment configuration and operational status belong to the installation owner; no credentials or private installation values are published here.
