import { defineConfig } from "vitest/config";

// Node environment, the worker's own tests only.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
