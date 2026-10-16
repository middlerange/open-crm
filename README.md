# Orbit

Orbit is a self-hosted CRM for company ownership, contacts, pipeline, follow-ups, team execution, approved assets, and permissioned agent work. Deploy the application on Cloudflare Workers with PostgreSQL, or run one Node application plus PostgreSQL.

**Release status:** alpha. Orbit is licensed under Apache 2.0, with Lucide icons under ISC/MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency attribution and [UI provenance](docs/UI_PROVENANCE.md) for the completed UI replacement review.

<!-- DEPLOY_BUTTON -->

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fmiddlerange%2Fopen-crm)

<!-- /DEPLOY_BUTTON -->

## Deploy on Cloudflare

1. Create an empty PostgreSQL database with a TLS connection URL. Cloudflare Hyperdrive is optional; it connects to PostgreSQL and does not provision the database itself.
2. Install Node 22+ and [Vite+](https://viteplus.dev/guide/), then run `vp install --frozen-lockfile`.
3. Copy `.env.cloudflare.example` to `.env.cloudflare`. Set `DATABASE_URL`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_NAME`, and a unique `BOOTSTRAP_PASSWORD` of at least 12 characters.
4. Sign in with `vp exec wrangler login`. Run `vp run deploy:check` for a local bundle check, then `vp run deploy` to deploy to your account.
5. Open the assigned `workers.dev` URL. The first API request applies migrations and creates the founder login. Sign in with the bootstrap credentials.

Custom domains, mailbox mappings, redirects, and Hyperdrive IDs come from environment values. The committed configuration contains no operator-specific domains or infrastructure IDs. [Deployment guide](docs/DEPLOYMENT.md) covers deploy buttons, optional email, upgrades, and Node/Docker installation.

## What it does

- One accountable owner per company, with domain, email, and LinkedIn duplicate protection.
- Founder and manager team-wide reporting; ICs see their own execution data and approved shared assets.
- Contacts, opportunities, tasks, activities, calendar, approvals, CSV/Excel import and export.
- User-bound agent keys with role and ownership enforcement.
- Optional LinkedIn engagement collector, configured for your deployment.
- Optional private/shared email inboxes, with explicit human send actions and sending disabled by default. The CRM does not automate outbound campaigns or LinkedIn outreach.

## Local development

Copy `.env.example` to `.env`, configure a development PostgreSQL database and founder credentials, and run:

```sh
vp install --frozen-lockfile
vp run db:setup
vp run dev
```

For the split frontend/API development servers set `APP_ORIGIN=http://localhost:5173`. The web app runs on port 5173 and the API on 8787. `DATABASE_SSL=require` is the default; use `disable` only for an explicitly trusted local database. To run the complete built Node application, use `vp run build` followed by `node --env-file=.env dist-server/index.mjs`; set `APP_ORIGIN=http://localhost:8787` for that mode.

On a fresh clone, run `vp run build:worker` (or `node scripts/prepare-worker-assets.mjs`) before `vp exec tsc --noEmit`; it generates `worker/migrations.generated.json`, which the type check imports.

## Optional integrations

Orbit can load the Userorbit widget. It is off by default. Set `USERORBIT_ACCOUNT_ID` (and optionally `USERORBIT_API_HOST`) to enable it; these are runtime settings and need no frontend rebuild. When `USERORBIT_ACCOUNT_ID` is set, the signed-in user's id, name, email, and role, plus the workspace name and id, are sent to Userorbit. Leave it empty to send nothing.

## Known limitations

- The Docker image build is not yet verified in CI.

## Checks and contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification commands and disposable database setup. See [SECURITY.md](SECURITY.md) for authentication protections and vulnerability reporting.

The deploy button targets `https://github.com/middlerange/open-crm`.
