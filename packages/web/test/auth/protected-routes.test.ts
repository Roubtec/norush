/**
 * Tests for protected route redirect logic.
 *
 * Simulates the (app) layout server load function and the hooks.server.ts
 * session validation to verify unauthenticated access is properly redirected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock WorkOS SDK
// ---------------------------------------------------------------------------

const mockAuthenticateWithSessionCookie = vi.fn();

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn().mockImplementation(() => ({
    userManagement: {
      authenticateWithSessionCookie: mockAuthenticateWithSessionCookie,
      getAuthorizationUrl: vi.fn(),
      getLogoutUrl: vi.fn(),
      authenticateWithCode: vi.fn(),
    },
  })),
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('WORKOS_API_KEY', 'sk_test_1234');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_test_1234');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'a_very_long_secret_password_for_testing_32chars!');
  vi.stubEnv('WORKOS_REDIRECT_URI', 'http://localhost:5173/auth/callback');

  mockAuthenticateWithSessionCookie.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulates the (app) +layout.server.ts load function behavior.
 * Throws a redirect (as SvelteKit does) if user is not in locals.
 */
function simulateProtectedLayoutLoad(locals: App.Locals) {
  if (!locals.user) {
    // SvelteKit redirect() throws a Redirect object
    throw { status: 302, location: '/login' };
  }

  return {
    user: {
      id: locals.user.id,
      email: locals.user.email,
      firstName: locals.user.firstName,
      lastName: locals.user.lastName,
    },
  };
}

/**
 * Simulates the hooks.server.ts session validation and locals population.
 *
 * The hook validates the session cookie on every request so `locals.user`
 * is available on all routes, including /login (for the already-authenticated
 * redirect) and /auth/logout (for WorkOS session revocation).
 */
async function simulateHook(
  _pathname: string,
  sessionCookie: string | undefined,
): Promise<App.Locals> {
  const locals: App.Locals = {};

  if (sessionCookie) {
    const { validateSession, resetWorkOS } = await import('$lib/server/auth');
    resetWorkOS();

    const session = await validateSession(sessionCookie);
    if (session.authenticated) {
      locals.user = {
        id: session.user.workosId,
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        sessionId: session.sessionId,
      };
    }
    // Note: in the real hook, invalid/expired sessions also delete the cookie.
  }

  return locals;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('protected route redirect logic', () => {
  it('redirects unauthenticated users to /login', () => {
    const locals: App.Locals = {}; // no user

    expect(() => simulateProtectedLayoutLoad(locals)).toThrow(
      expect.objectContaining({
        status: 302,
        location: '/login',
      }),
    );
  });

  it('allows authenticated users through', () => {
    const locals: App.Locals = {
      user: {
        id: 'user_01AUTH',
        email: 'auth@example.com',
        firstName: 'Auth',
        lastName: 'User',
        sessionId: 'sess_123',
      },
    };

    const data = simulateProtectedLayoutLoad(locals);
    expect(data.user.id).toBe('user_01AUTH');
    expect(data.user.email).toBe('auth@example.com');
  });

  it('hooks populate locals.user for valid session on protected routes', async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: true,
      sessionId: 'sess_valid',
      user: {
        id: 'user_01HOOK',
        email: 'hook@example.com',
        firstName: 'Hook',
        lastName: 'Test',
      },
    });

    const locals = await simulateHook('/dashboard', 'valid_sealed_session');

    expect(locals.user).toBeDefined();
    expect(locals.user?.id).toBe('user_01HOOK');
    expect(locals.user?.email).toBe('hook@example.com');
    expect(locals.user?.sessionId).toBe('sess_valid');
  });

  it('hooks do NOT populate locals.user for invalid session', async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: false,
      reason: 'invalid_jwt',
    });

    const locals = await simulateHook('/dashboard', 'expired_session');

    expect(locals.user).toBeUndefined();
  });

  it('hooks do not call WorkOS when no session cookie is present on /login', async () => {
    const locals = await simulateHook('/login', undefined);

    expect(locals.user).toBeUndefined();
    expect(mockAuthenticateWithSessionCookie).not.toHaveBeenCalled();
  });

  it('hooks populate locals.user on /login when a valid session cookie is present', async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: true,
      sessionId: 'sess_login',
      user: {
        id: 'user_01LOGIN',
        email: 'login@example.com',
        firstName: 'Login',
        lastName: 'Test',
      },
    });

    const locals = await simulateHook('/login', 'valid_sealed_session');

    expect(locals.user).toBeDefined();
    expect(locals.user?.id).toBe('user_01LOGIN');
    expect(locals.user?.sessionId).toBe('sess_login');
  });

  it('hooks populate locals.user on /auth/logout when a valid session cookie is present', async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: true,
      sessionId: 'sess_logout',
      user: {
        id: 'user_01LOGOUT',
        email: 'logout@example.com',
        firstName: 'Logout',
        lastName: 'Test',
      },
    });

    const locals = await simulateHook('/auth/logout', 'valid_sealed_session');

    expect(locals.user).toBeDefined();
    expect(locals.user?.sessionId).toBe('sess_logout');
  });

  it('hooks do not call WorkOS when no session cookie is present on /auth/callback', async () => {
    const locals = await simulateHook('/auth/callback?code=abc', undefined);

    expect(locals.user).toBeUndefined();
    expect(mockAuthenticateWithSessionCookie).not.toHaveBeenCalled();
  });

  it('hooks do not call WorkOS when no session cookie is present on /api/health', async () => {
    const locals = await simulateHook('/api/health', undefined);

    expect(locals.user).toBeUndefined();
    expect(mockAuthenticateWithSessionCookie).not.toHaveBeenCalled();
  });

  it('end-to-end: unauthenticated user on protected route gets redirected', async () => {
    const locals = await simulateHook('/dashboard', undefined);

    expect(locals.user).toBeUndefined();
    expect(() => simulateProtectedLayoutLoad(locals)).toThrow(
      expect.objectContaining({
        status: 302,
        location: '/login',
      }),
    );
  });
});
