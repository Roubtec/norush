import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const currentDir = dirname(fileURLToPath(import.meta.url));

// We alias `$env/dynamic/private` to a local shim because Vitest does not
// run SvelteKit's server handler that normally populates the module's
// `private_env`. The shim is a live Proxy over `process.env`, so tests can
// still set values with `vi.stubEnv(...)` and the server code under test
// reads them as expected.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      $lib: resolve(currentDir, 'src/lib'),
      '$env/dynamic/private': resolve(currentDir, 'test/env-shim.ts'),
    },
  },
});
