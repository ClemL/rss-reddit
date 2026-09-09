import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws on import outside a React Server Component build.
      // Aliasing it away lets the server modules it guards be unit tested.
      "server-only": fileURLToPath(new URL("./src/lib/__mocks__/server-only.ts", import.meta.url)),
    },
  },
});
