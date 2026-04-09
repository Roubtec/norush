import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "$lib": resolve(__dirname, "src/lib"),
    },
  },
});
