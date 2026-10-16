# Deploying Orbit

## Cloudflare deploy button

Cloudflare's [Deploy to Cloudflare flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/) clones a public GitHub/GitLab repository, lets the operator configure values, and builds/deploys their own Worker. The source repository must exist before a working button can be published. The button targets [middlerange/open-crm](https://github.com/middlerange/open-crm). The exporter can override its destination with `ORBIT_PUBLIC_REPOSITORY_URL`.

This application still requires an operator-owned PostgreSQL database. It does not use D1; Hyperdrive is an optional connection pool in front of PostgreSQL. Start with the database connection URL, founder credentials, and optionally the Userorbit account ID. The deploy-button secret prompts are declared in `.dev.vars.example`; descriptions live in `package.json`.

Use the Workers Builds settings below. The build script installs the pinned Vite+ CLI and dependencies, then checks the application; the deploy script builds and publishes it.

Secrets supplied by the deployment UI must be bound to the Worker. If they are also present in the build process environment, the deploy script passes only the explicit secret allowlist using Wrangler's secrets file. It never puts credentials in the generated Wrangler configuration. Existing Worker secrets are retained. Verify the chosen deployment's runtime bindings before opening the app.

## Automatic releases from GitHub

Connect the repository from the **existing Worker → Settings → Build → Connect**. Select your repository and `main` as the production branch. Keep the same Worker name, PostgreSQL database, Hyperdrive resource, domains, and cookie name when transitioning an existing installation.

| Cloudflare build setting                 | Value                                                    |
| ---------------------------------------- | -------------------------------------------------------- |
| Root directory                           | `/`                                                      |
| Production branch                        | `main`                                                   |
| Build command                            | `bash scripts/cloudflare-build.sh`                       |
| Deploy command                           | `PATH="$HOME/.vite-plus/bin:$PATH" vp run deploy`        |
| Non-production branch builds             | Disabled until a separate staging database is configured |
| Build variable `NODE_VERSION`            | `22`                                                     |
| Build variable `SKIP_DEPENDENCY_INSTALL` | `true`                                                   |

Set deployment-specific variables from the table below in **Build variables and secrets**. The deployment script explicitly copies the listed runtime settings into the Worker configuration and uses `ORBIT_*` infrastructure settings to generate bindings and routes. Cloudflare does not copy arbitrary build variables to runtime automatically. Do not prefix private settings with `VITE_`.

For an existing Worker, retain `DATABASE_URL` in **Settings → Variables and Secrets** as a runtime secret; it is not needed in the build environment. Existing secrets are preserved. Do not set founder bootstrap credentials when retaining an existing database. Keep the build API token managed by Cloudflare; do not copy your personal Wrangler OAuth token into GitHub or source control.

A successful production build deploys automatically after a push to `main`. The Cloudflare build runs type, lint, unit, and deployment checks before the deploy command. The separate GitHub `Verify` workflow runs the PostgreSQL integration/security suites; Cloudflare does not wait for that workflow. Require `Verify / check` to pass on pull requests before merging to `main` if database integration checks must gate releases. Configure a separate staging Worker and database before enabling preview builds.

Before the first deployment, take a PostgreSQL backup and record the current Worker version. After deployment, verify `/health`, login, existing CRM records and roles, the widget, domain redirects, and email configuration. Migrations run on the first API request. Worker rollback restores code, not database migrations; upgrades should keep SQL backward compatible.

See Cloudflare's [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [build image settings](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/). A Cloudflare GitHub App connection may require the repository owner's authorization in the dashboard.

## Local CLI deployment

Copy `.env.cloudflare.example` to `.env.cloudflare`, fill it in, and run:

```sh
vp install --frozen-lockfile
vp exec wrangler login
vp run deploy:check
vp run deploy
```

A different environment file can be passed as `vp run deploy path/to/environment-file`. Process environment values take precedence. The script generates ignored `wrangler.local.json`; secret values go in an ignored mode-0600 temporary file removed after the command. Never commit either generated file or a filled environment file. The default `.env` used for local Node development is not loaded by this deployment script.

| Setting                                                   | Purpose                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ORBIT_WORKER_NAME`                                       | Worker name, default `orbit-gtm`.                                                                                                       |
| `DATABASE_URL`                                            | Secret PostgreSQL URL; required unless Hyperdrive supplies the connection.                                                              |
| `ORBIT_HYPERDRIVE_ID`                                     | Optional existing Hyperdrive ID, connected to your PostgreSQL database. Disable Hyperdrive query caching for consistent auth/CRM reads. |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_NAME`, `BOOTSTRAP_PASSWORD` | Initial founder. Password at least 12 characters. Only used for an empty installation; not a password-reset mechanism.                  |
| `APP_ORIGIN`                                              | Optional HTTPS origin; defaults to the incoming Worker origin. Set this when using your canonical custom domain.                        |
| `ORBIT_CUSTOM_DOMAINS`                                    | Comma-separated hostnames in your Cloudflare account, no scheme/path.                                                                   |
| `ORBIT_REDIRECT_ORIGINS`                                  | Comma-separated full origins to redirect to `APP_ORIGIN`.                                                                               |
| `USERORBIT_ACCOUNT_ID`                                    | Your public widget account identifier. The widget is inactive while empty.                                                              |
| `USERORBIT_API_HOST`                                      | HTTPS API origin, default `https://api.userorbit.com`.                                                                                  |
| `SESSION_COOKIE_NAME`                                     | Default `orbit_session`.                                                                                                                |
| `DATABASE_SSL`                                            | `require` by default. `disable` is only for trusted local/private connections. Hyperdrive transport is handled separately.              |

For a custom domain, set `APP_ORIGIN` and `ORBIT_CUSTOM_DOMAINS` together. Keep the same Worker name and database when upgrading. Back up PostgreSQL before upgrading. On the first API request to a new Worker version, bundled SQL migrations are applied under a transaction-scoped PostgreSQL table lock. Existing installations keep their users and data. Startup errors return a generic 503 without credentials or SQL details.

After bootstrap, remove the bootstrap password secret from the Worker if desired; an existing installation does not require it. Never expose a database with unrestricted network access just to satisfy a deploy button.

## Optional email

Email is off by default. Configure Cloudflare Email Service and routing for a domain you control before enabling it. The basic CRM, widget, and agent API work without email setup.

- `ORBIT_EMAIL_BINDING=true` adds the Worker `MAILER` binding.
- `MAIL_DOMAINS` is a comma-separated list of verified mailbox domains.
- `MAIL_DOMAIN_WORKSPACES` is a JSON domain-to-workspace-slug map, for example `{"example.com":"orbit-gtm"}`.
- `MAIL_INBOUND_ALIASES` is a JSON map of trusted routing addresses to final mailbox addresses. Mapping is one hop; destination domains must be configured above.
- `MAIL_SENDING_ENABLED=true` enables explicit human sends once the provider is ready.
- Cloudflare email routing/DNS verification and routing to the Worker remain separate account setup steps. The deploy button does not do these for the operator.
- Node deployments can instead use secret `CLOUDFLARE_EMAIL_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_API_TOKEN`; inbound bridging requires a random `MAIL_INGRESS_SECRET` of at least 32 characters.

## Node and Docker

The Node server applies migrations and bootstraps the founder before serving both the API and built frontend. Unknown API paths remain JSON 404 responses; browser deep links serve the SPA.

For Docker, copy `.env.example` to `.env`, set a random `POSTGRES_PASSWORD`, founder credentials, and `APP_ORIGIN=http://localhost:8787`, then run:

```sh
docker compose up --build -d
```

Open `http://localhost:8787`. Compose configures its private PostgreSQL connection with SSL disabled; the application default elsewhere remains TLS-required. Put public Node installations behind an HTTPS reverse proxy and set `APP_ORIGIN` to its public origin. The Dockerfile uses Vite+ for dependency/build operations. Docker image execution must also be checked on a host with a running Docker daemon.

## Extension and private research

Generate the extension for your deployment using `vp run extension:configure .env.cloudflare` and load `.release/extension` in Chrome. See `chrome-extension/README.md` for details. It does not send outreach.

Internal research is excluded from public builds and release exports. An existing private installation can opt in with both `ORBIT_INCLUDE_PRIVATE_RESEARCH=true` during build and `CONTENT_RESEARCH_ENABLED=true` at runtime, if its local `content-research` directory is present. Research API access requires a founder or manager. Raw research asset URLs are blocked by the Worker. Do not include private research in a public source repository.
