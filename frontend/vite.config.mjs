import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@platform/contracts": fileURLToPath(new URL("../packages/contracts/src/index.ts", import.meta.url)) } },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    proxy: { "/api": "http://127.0.0.1:3001" },
    warmup: {
      clientFiles: ["./src/main.ts"],
    },
  },
  plugins: [vue()],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTransformMode: {
      web: [
        "**/extension-editors.test.ts",
        "**/form-runtime.test.ts",
        "**/base-dialog.test.ts",
        "**/record-print-dialog.test.ts",
        "**/configuration-recovery.test.ts",
      ],
    },
  },
});
