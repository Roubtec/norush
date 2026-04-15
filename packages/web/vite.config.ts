import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [sveltekit()],
  // Load .env/.env.local from the monorepo root so DATABASE_URL and other
  // host-dev vars are available without duplicating them in packages/web/.
  // In Docker builds the root has no .env files — Vite silently skips them
  // and env vars arrive via compose's environment: block at runtime.
  envDir: resolve(import.meta.dirname, '../../'),
});
