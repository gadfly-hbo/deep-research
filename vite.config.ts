import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  esbuild: { jsx: "automatic" },
  build: { outDir: "../ui-dist", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://127.0.0.1:4173" },
  },
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
  },
} as Parameters<typeof defineConfig>[0] & { test: unknown });
