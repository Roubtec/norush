import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "$lib": resolve(currentDir, "src/lib"),
    },
  },
});
