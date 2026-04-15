/**
 * Test-only replacement for SvelteKit's `$env/dynamic/private` module.
 *
 * The real module is backed by a `private_env` variable that SvelteKit's
 * server handler populates at request time. Vitest never runs that handler,
 * so the module reads as empty. We alias `$env/dynamic/private` to this shim
 * (see `vitest.config.ts`) so server code imported from tests reads
 * `process.env` directly — which keeps `vi.stubEnv(...)` working as expected.
 */

export const env: Record<string, string | undefined> = new Proxy(
  {},
  {
    get: (_target, key: string) => process.env[key],
    has: (_target, key: string) => key in process.env,
  },
);
