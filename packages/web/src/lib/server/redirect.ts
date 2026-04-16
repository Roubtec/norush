import { env } from '$env/dynamic/private';

/**
 * Post-login redirect helpers.
 *
 * The login flow accepts a `?next=<path>` parameter so that an expired
 * session on (e.g.) /chat sends the user through /login and back to /chat
 * after re-authenticating. The path is short-lived in a cookie because the
 * WorkOS round-trip drops our query string.
 *
 * Sanitization rules — applied both when accepting the param on /login and
 * again when consuming the cookie in /auth/callback (defense in depth):
 *
 *   - Must be a non-empty string starting with exactly one "/".
 *   - May not start with "//", "/\", or contain any "\" anywhere — these
 *     can be normalized by some browsers to a protocol-relative URL,
 *     enabling open-redirect attacks (e.g. `//evil.com/foo`).
 *   - May not contain control characters.
 *   - May not loop back into the auth flow (`/login`, `/auth/...`).
 *   - Must round-trip through `new URL()` against a dummy origin without
 *     escaping it — catches anything the explicit checks miss.
 *
 * Route existence is not validated. SvelteKit does not expose its route
 * manifest as stable runtime API, and the user accepted that an unknown
 * sanitized path may resolve to a 404 (preferable to silently dropping it).
 */

const DUMMY_ORIGIN = 'https://norush.invalid';

/**
 * Validate an externally-supplied next-path. Returns the canonicalized
 * `pathname + search` (no hash — hashes never reach the server) when safe,
 * or `null` to indicate the caller should fall back to the default landing.
 */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (raw.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, DUMMY_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== DUMMY_ORIGIN) return null;

  const pathname = parsed.pathname;
  if (pathname === '/login' || pathname.startsWith('/login/')) return null;
  if (pathname.startsWith('/auth/')) return null;

  return pathname + parsed.search;
}

/** Cookie that carries the sanitized next-path across the WorkOS round-trip. */
export const NEXT_COOKIE = 'norush_login_next';

/** Cookie attributes — short TTL, HttpOnly, SameSite=Lax for the OAuth callback. */
export const NEXT_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 10 * 60,
};
