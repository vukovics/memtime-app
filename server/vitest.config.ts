import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      // index.ts is process wiring (env, listen); exercised by e2e, not unit tests.
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
