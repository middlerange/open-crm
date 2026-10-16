# Contributing

Use Node 22+ and Vite+ (`vp`). Keep one accountable owner per company, duplicate protections, and role/ownership checks. Outreach remains a human action. Do not commit credentials, real customer records, or operator-specific deployment configuration.

Install with `vp install --frozen-lockfile`. Build generated Worker assets before the typecheck:

```sh
vp run build:worker
vp exec tsc --noEmit
vp run test:unit
vp run test:deployment
vp run test:extension-auth
vp run test:extension-ui
vp check
vp run build
```

Database-backed suites require disposable PostgreSQL databases. Some legacy scripts automatically read `.env`; override `DATABASE_URL` explicitly with a test URL or use the direct test command below. Never run these suites against production. The setup test requires a separate empty test database.

```sh
DATABASE_URL=postgres://orbit_test@127.0.0.1:5432/orbit_test DATABASE_SSL=disable NODE_ENV=test vp exec tsx --test --test-concurrency=1 server/crm-api.test.ts server/crm-transfer.test.ts server/agent-api.test.ts server/agent-access.test.ts server/mail-provider.test.ts server/mail-ingress.test.ts server/mail-backend.test.ts server/mail-security.test.ts server/workspace-auth.test.ts
ORBIT_SECURITY_TEST_DATABASE_URL=postgres://orbit_test@127.0.0.1:5432/orbit_test DATABASE_SSL=disable NODE_ENV=test vp run test:security
ORBIT_INSTALL_TEST_DATABASE_URL=postgres://orbit_test@127.0.0.1:5432/orbit_install_test DATABASE_SSL=disable NODE_ENV=test vp run test:installation
```

Provide the problem, behavior change, and relevant verification with a contribution. Document new settings in `.env.example` and `docs/DEPLOYMENT.md`. New third-party code must include provenance and a compatible license. Preserve the notices in `THIRD_PARTY_NOTICES.md` and follow `docs/UI_DESIGN_SYSTEM.md`. Do not add code or assets copied from noncommercial reference implementations.
