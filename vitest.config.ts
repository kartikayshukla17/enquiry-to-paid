import { defineConfig } from "vitest/config";

// Site-level (src/) unit tests, separate from agent/vitest.config.ts. Scoped to src/ only so this
// never picks up the agent package's own test files when run from the repo root.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
