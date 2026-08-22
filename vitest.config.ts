import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Gated *.integration.test.ts suites talk to a real PostgreSQL instance
    // that may be remote, where the 5s default times out on latency alone.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});

