# WorkOS AuthKit Integration Guide

Practical notes for operating norush's WorkOS AuthKit integration across local
development, staging, and production. Written to answer the questions a first-time
WorkOS operator tends to hit before they are a problem.

## Where identity lives

WorkOS AuthKit is the **source of truth** for user identity. It stores:

- Email addresses (unique per environment — see below)
- Password hashes and/or social-login linkages
- MFA factors, verification state, metadata

norush's own PostgreSQL database stores only a **1:1 mirror row** in `users`
keyed by the WorkOS user ID (e.g. `user_01ABC...`), plus a `user_settings` row.
See [packages/web/src/lib/server/user.ts](../packages/web/src/lib/server/user.ts).

The `provisionUser` function uses `INSERT ... ON CONFLICT DO NOTHING`, so it is
idempotent — every login re-runs it harmlessly.

### Implication: the local DB is disposable

Truncating or dropping the local Postgres database does **not** require
re-onboarding users with WorkOS. On the user's next login:

1. WorkOS authenticates them (identity still exists in WorkOS).
2. `hooks.server.ts` receives the WorkOS user ID from the sealed session.
3. `provisionUser` recreates the local `users` + `user_settings` rows.

You only lose norush-side data (API keys in the vault, settings, request
history, etc.), **not** the ability to sign in.

### When you *do* need the WorkOS dashboard

You need to delete users in the WorkOS dashboard (or via
`workos.userManagement.deleteUser`) when:

- You want to **re-run the onboarding flow from scratch** for a given email.
  Emails uniquely identify users per environment; once WorkOS has seen
  `foo@example.com`, a new signup with that address will fail until you delete
  the user.
- You want to test email verification, MFA enrollment, or the "first-time user"
  UX — any path that only runs on user creation.
- You want to clean up test users accumulated from E2E runs.

Deletion is available in the Dashboard → Users page and via the API.

## Environments: your staging/prod firewall

WorkOS workspaces ship with two environments by default:

| Environment    | Purpose                        | Redirect URI rules            |
| -------------- | ------------------------------ | ----------------------------- |
| **Staging**    | Local dev, CI, preview deploys | `http://` and `localhost` OK  |
| **Production** | Live traffic only              | HTTPS only, no localhost, must be a domain you control |

Each environment has:

- Its own **API key** (`sk_test_...` vs. `sk_live_...`)
- Its own **Client ID**
- Its own **user directory** — a user created in Staging does **not** exist in
  Production, and vice versa.
- Its own redirect URI allowlist.
- Its own AuthKit branding/configuration.

### Implication: you get environment isolation for free

- Local testing garbage (dev accounts, throwaway emails, E2E users) stays in
  Staging and never pollutes the Production user list.
- You can truncate-and-rebuild the Staging user directory without risk to real
  users.
- Billing: WorkOS doesn't charge for Staging activity. Only production MAUs
  count.

### Which keys to put where

- `.env` (local) + CI: use **Staging** keys.
  - `WORKOS_API_KEY=sk_test_...`
  - `WORKOS_CLIENT_ID=client_01...` (staging client)
- Azure Container Apps (production deploy): use **Production** keys, stored as
  GitHub/Azure secrets — never committed.

You may want a third environment (e.g. "Preview" or "Staging-deploy") once you
have a real staging deploy; WorkOS supports adding more environments in the
dashboard.

## Multiple localhost ports in one environment

norush has two valid local URLs depending on how you run it:

- `http://localhost:3000` — full-stack Docker (`pnpm dev:up`)
- `http://localhost:5173` — host-mode Vite (`pnpm host:dev`)

**The same Staging environment can serve both.** AuthKit reads redirect URIs
from a per-environment allowlist. In the WorkOS dashboard → Redirects, add
**both** as allowed redirect URIs:

```
http://localhost:3000/auth/callback
http://localhost:5173/auth/callback
```

Pick one as the default (the default is only used when no `redirect_uri` is
passed in the authorize call — norush always passes one explicitly via
`WORKOS_REDIRECT_URI`, so either default is fine).

At runtime, the redirect URI is chosen via env vars:

- `.env` → `WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback`
- `.env.local` → `WORKOS_REDIRECT_URI=http://localhost:5173/auth/callback`

Vite loads `.env.local` last and it wins, so `pnpm host:dev` uses port 5173
automatically while Docker Compose (which ignores `.env.local`) uses port 3000.

### User accounts are shared across ports

User identity in WorkOS is scoped to **environment**, not redirect URI. A user
who signs up via port 3000 can log in at port 5173 with the same credentials —
it's one account, one user directory. The shared local Postgres reinforces this
since both modes point at the same DB on `localhost:5432`.

### Cookie-domain caveat

Session cookies are scoped to the **hostname** (and path), not the port, so a cookie set for `localhost` is sent to both `localhost:3000` and `localhost:5173`.

If a session does not validate after switching ports, the cause is a configuration mismatch between the two server processes rather than port isolation.

Common causes:

- different `WORKOS_COOKIE_PASSWORD` values, which makes an existing cookie unreadable to the other server
- different cookie name, path, domain, `SameSite`, or `Secure` settings
- using a different hostname (`127.0.0.1` vs `localhost`)
- mixing `http` and `https` when `Secure` cookies are enabled

WorkOS shares the same underlying user account across both ports; if you are prompted to sign in again, treat it as a cookie/config mismatch to debug.

## Wildcards (optional)

If the port-juggling gets tedious, WorkOS supports a single wildcard segment in
a redirect URI: `http://localhost:*/auth/callback` would cover both ports. Two
caveats:

- Wildcards cannot be the **default** redirect URI — you still need one
  concrete default.
- Wildcards do **not** cross multiple subdomain/path segments.
- They're only worth enabling in Staging; Production should have a fixed
  allowlist.

## Custom Domain (paid feature)

WorkOS offers a "Custom Domain" add-on (~$99/mo) that covers three things in
**Production only** — Staging always uses WorkOS-owned domains:

| Surface          | Default (free)                          | With custom domain                |
| ---------------- | --------------------------------------- | --------------------------------- |
| AuthKit hosted UI | Brief redirect through `*.workos.com`  | `auth.yourdomain.com`             |
| Admin Portal      | Invite/management URLs on `*.workos.com` | Your subdomain                  |
| Email sender      | `noreply@workos-mail.com`               | `noreply@yourdomain.com`          |

It is purely cosmetic / trust polish — no functional, security, or deliverability
difference. Skip it for early-stage norush; revisit when:

- Users complain about emails coming from `workos-mail.com`, or
- Enterprise prospects ask why login briefly redirects through a third party.

## Operational checklist

Before opening your WorkOS account:

- [ ] Decide which email you'll own the account with (ideally a role/shared
      inbox, not a personal one).

After opening the account:

- [ ] In **Staging**, add both `http://localhost:3000/auth/callback` and
      `http://localhost:5173/auth/callback` as redirect URIs.
- [ ] Copy the **Staging** API key and Client ID into `.env` locally.
- [ ] Generate a 32+ character `WORKOS_COOKIE_PASSWORD` (e.g.
      `openssl rand -base64 48`) and put it in `.env`.
- [ ] Flip `NORUSH_DEV_AUTH_BYPASS=1` → `0` (or comment it out) in `.env` to
      exercise the real flow.
- [ ] Create one test user to verify the round-trip.

Before the first production deploy:

- [ ] Configure the **Production** environment's redirect URI to the real
      HTTPS callback URL.
- [ ] Store the Production API key / Client ID / cookie password as GitHub
      Actions secrets (never in `.env`).
- [ ] Confirm `NODE_ENV=production` in the deployed container so the
      dev-auth-bypass can never activate.

## Good-stewardship notes

- **Rotate `WORKOS_COOKIE_PASSWORD`** if you suspect leakage. All sealed
  sessions become invalid on rotation, which logs everyone out — expected.
- **Don't reuse the same cookie password across environments.** Staging and
  Production sealed sessions should be cryptographically independent.
- **Delete test users periodically** in the Staging dashboard so the directory
  doesn't bloat, especially if you script account creation in E2E tests.
- **Enable MFA enforcement in Production only** once you've verified the UX in
  Staging — AuthKit settings are per-environment.

## References

- [WorkOS: Modeling Your App](https://workos.com/docs/authkit/modeling-your-app)
- [WorkOS: Redirect URIs](https://workos.com/docs/sso/redirect-uris)
- [WorkOS: Redirect URIs for local, staging, and production](https://workos.com/blog/redirect-uris-for-local-staging-and-production)
- [WorkOS: Users and Organizations](https://workos.com/docs/authkit/users-organizations)
- [WorkOS: Delete User API](https://workos.com/docs/reference/authkit/user/delete)
- [WorkOS: Default OAuth credentials for Staging](https://workos.com/changelog/default-oauth-credentials-for-staging-environments)
