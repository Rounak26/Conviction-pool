import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    // @meteora-ag/dlmm@1.9.14's ESM build uses a directory import that Node's strict
    // ESM loader rejects; point tests at the package's CJS build instead.
    alias: { "@meteora-ag/dlmm": require.resolve("@meteora-ag/dlmm") },
  },
});
