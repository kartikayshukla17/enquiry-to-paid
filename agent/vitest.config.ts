import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./src/security/test-setup.ts"] },
});
