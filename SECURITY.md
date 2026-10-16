# Security

Orbit is an early self-hosted CRM. Security fixes target the current source version;
there is no long-term support or independent security certification yet.

## Reporting a vulnerability

Use the repository's private vulnerability reporting feature if it is enabled.
Otherwise, contact the repository maintainer privately through their published
profile before sharing details. Do not post credentials, customer records, or an
exploitable vulnerability in a public issue. Include the affected version,
reproduction steps using synthetic data, and the expected access boundary.

## Deployment requirements

- Serve the app over HTTPS and set `NODE_ENV=production` and `APP_ORIGIN` to the
  exact public HTTPS origin. Production session cookies are secure and HTTP-only.
- Use unique bootstrap credentials and keep environment files, database backups,
  browser-extension local configuration, and Cloudflare state out of published
  source, build contexts, and artifacts. Remove bootstrap credentials from the
  deployment after provisioning the first account.
- Restrict PostgreSQL network access, use a dedicated database role, and maintain
  encrypted backups with tested restoration. Apply migrations before serving a
  new version, including migration 016 for authentication throttling.
- Put a trusted reverse proxy or gateway in front of public deployments with
  request-size, connection, and IP-based rate limits. Strip untrusted forwarded
  headers before adding your own. The application does not trust forwarded IPs
  for authentication throttling.
- Keep outbound sending disabled until the deployment operator explicitly
  configures and validates it. Never treat a development database as production.

## Access boundaries and authentication

Private content research is disabled by default. An operator who intentionally
ships their own research must set `ORBIT_INCLUDE_PRIVATE_RESEARCH=true` during
the Worker build and `CONTENT_RESEARCH_ENABLED=true` in the runtime environment.
Only founders and managers can access its authenticated API. Direct asset URLs
must remain blocked. Never enable these flags for a public demonstration or
release archive containing private company research.

Workspace membership determines the active session's role. Founders and managers
can view team reporting; individual contributors are restricted to their own
execution records and shared approved assets. Company ownership and duplicate
protections must remain intact when extending CRM endpoints. Agent keys and
extension tokens must retain their workspace and permission scopes.

Passwords use Argon2id. Session and invitation tokens are opaque random values;
the database stores their hashes. Password login allows ten attempts per
normalized email address in a fifteen-minute window. Invitation acceptance has
the same limit per invitation token, and password verification for an existing
invitee shares the email limit. Counters are stored in PostgreSQL, making them
consistent across app instances and restarts. Requests beyond the limit receive
HTTP 429 with `Retry-After`; successful login does not reset the window. Expired
counter rows are removed on subsequent authentication attempts.

Account-based limits can temporarily block a targeted account and do not stop
distributed traffic across many identifiers. Gateway-level limits remain
necessary. Session metadata may include forwarded IP information for auditing;
it is not proof of client identity. Keep logs and audit records private.

## Testing changes

Run security and integration tests only against a disposable local PostgreSQL
database. The authentication-limit test requires
`ORBIT_SECURITY_TEST_DATABASE_URL` explicitly, accepts only loopback hosts and a
database name containing `test`, and does not load `.env`:

```sh
DATABASE_SSL=disable ORBIT_SECURITY_TEST_DATABASE_URL=postgres://orbit_test@127.0.0.1:55438/orbit_security_test vp exec tsx --test server/auth-rate-limit.test.ts
```

Before releasing a public source archive, scan its complete contents and Git
history for secrets and private business data. Passing tests does not establish
that an archive or historical commit is safe to publish.
