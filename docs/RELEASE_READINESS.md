# Release readiness

Reviewed October 16, 2026. This is an alpha preparation record, not a claim that a public launch or production deployment occurred.

## Implemented

- Generic Cloudflare configuration with environment-driven Worker name, domains, redirects, mailbox mappings, Hyperdrive, and Userorbit account.
- Separate allowlists for runtime values and secrets, ignored private configuration, and dry-run deployment command.
- Bundled SQL migrations and automatic first-request founder bootstrap; concurrent setup uses PostgreSQL advisory locks.
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

1. **Public repository and deploy-button verification:** the button targets `https://github.com/middlerange/open-crm`. Publish the prepared source with its license notices, then test the complete dashboard flow in a separate Cloudflare account. A CLI dry run does not verify that hosted onboarding flow.
2. **Docker execution:** Compose configuration and native Node installation were verified; image build/run was not possible without a running Docker daemon.
3. **Publication secret/history scan:** this workspace has no Git metadata. Exported files can be inspected, but no historical commit scan is possible here. Before publication, scan the actual repository and any imported history, enable secret scanning, and confirm a working private security-reporting channel.
4. **Third-party dependency provenance:** installed dependencies retain their own licenses. Review dependency notices for the exact distributed artifact; adding an Apache license does not grant rights to third-party code.

Cloudflare Email domain verification and PostgreSQL provisioning are operator setup steps. The basic app does not require email, and sending remains disabled by default. No production database, Worker deployment, repository visibility, or outreach was changed during this preparation.
