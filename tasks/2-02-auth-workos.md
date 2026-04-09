# Integrate WorkOS AuthKit for Authentication

## Why this task exists

Users need to sign up, log in, and maintain sessions before they can use norush.chat.
WorkOS AuthKit provides social login, passkeys, MFA, and enterprise SSO with minimal code.

## Scope

**Included:**
- WorkOS AuthKit integration using the official TypeScript SDK
- Login, signup, and logout flows
- Session management via SvelteKit server hooks
- Protected routes: redirect unauthenticated users to login
- User record creation in `users` table on first login
- Auth-related environment variables: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`

**Out of scope:**
- API key vault (task 2-03)
- Chat functionality (task 2-04)
- Enterprise SSO configuration (operational concern, not code)
- User profile editing beyond what WorkOS provides

## Context and references

- PLAN.md Section 6.8 (Authentication) — WorkOS AuthKit features, rationale, lock-in assessment
- PLAN.md Section 5.1 (norush.chat) — user flow step 1: sign up / log in
- PLAN.md Section 6.7 (Three-Tier Configuration) — `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` as Tier 1 env vars

## Target files or areas

```
packages/web/src/
├── hooks.server.ts           # Add auth middleware: validate session, attach user to locals
├── lib/
│   └── server/
│       ├── auth.ts           # WorkOS SDK initialization, session helpers
│       └── user.ts           # User lookup/creation in database
├── routes/
│   ├── auth/
│   │   ├── callback/
│   │   │   └── +server.ts   # OAuth callback handler
│   │   └── logout/
│   │       └── +server.ts   # Logout endpoint
│   ├── login/
│   │   └── +page.svelte     # Login page (redirect to WorkOS hosted UI)
│   └── (app)/
│       └── +layout.server.ts # Protected layout: require auth, load user
```

## Implementation notes

- **WorkOS AuthKit** provides a hosted login UI — the login page redirects to WorkOS, which redirects back to `/auth/callback`.
- **Session management:** Use WorkOS session tokens stored in HTTP-only secure cookies. Validate in `hooks.server.ts` on every request.
- **User provisioning:** On first successful login, create a row in the `users` table and `user_settings` table (with defaults). Use the WorkOS user ID or generate a ULID — decide based on what's simpler for foreign key consistency.
- **Protected routes:** Use a SvelteKit route group `(app)` for all authenticated pages. The group layout server load function checks auth and redirects to `/login` if unauthenticated.
- **`locals` typing:** Add the authenticated user to `app.d.ts` locals so it's available in all server routes.
- Install `@workos-inc/node` (WorkOS Node SDK) as a dependency of `@norush/web`.

### Dependencies

- Requires task 2-01 (SvelteKit scaffold).
- Requires task 1-03 (Store — for `users` and `user_settings` table access).

## Acceptance criteria

- Users can sign up and log in via WorkOS hosted UI.
- Successful login creates a session cookie and redirects to the app.
- `hooks.server.ts` validates the session on every request and populates `locals.user`.
- Unauthenticated requests to `(app)` routes redirect to `/login`.
- First login creates a `users` record and `user_settings` record with defaults.
- Logout clears the session and redirects to `/login`.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Manual test: visit a protected route → redirected to login → log in → redirected back → user visible.
- Manual test: log out → session cleared → protected routes redirect again.
- Verify `users` table has a new row after first login.
- Verify cookie is HTTP-only and secure (in production mode).

## Review plan

- Verify session validation happens in hooks (not duplicated per route).
- Verify user provisioning is idempotent (login again doesn't create duplicates).
- Check that WorkOS SDK is initialized with env vars, not hardcoded values.
- Confirm `locals` type is properly declared in `app.d.ts`.
