#!/usr/bin/env node

import { access } from "node:fs/promises";

const entrypoint = new URL("../dist/cli/rotate-key.js", import.meta.url);

try {
  await access(entrypoint);
} catch {
  console.error(
    "The @norush/core CLI has not been built yet. Run `pnpm --filter @norush/core build` or `pnpm build` first.",
  );
  process.exit(1);
}

const { main } = await import(entrypoint.href);
await main();
