import { defineConfig } from "vitest/config";

// Opt-in integration suite. Runs only the live-staging integration file and
// auto-loads .env (via dotenv/config) so COOLIFY_TEST_* never need to be
// exported on the shell command line. All cases self-skip when the env vars
// are absent (see integration.test.ts).
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/__tests__/integration.test.ts"],
    setupFiles: ["dotenv/config"],
    passWithNoTests: true,
  },
});
