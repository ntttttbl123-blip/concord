import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The API serves the built dashboard itself; in development Vite serves it and passes /api through.
const api = `http://127.0.0.1:${process.env.CONCORD_PORT ?? process.env.PORT ?? 4400}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
  server: {
    port: 4401,
    proxy: { "/api": api },
  },
});
