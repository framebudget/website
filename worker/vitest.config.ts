import { defineConfig } from "vitest/config";

// The worker's own config, so vitest does not pick up the library's config at
// the repository root (and the root node_modules it needs).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
