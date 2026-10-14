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
    testTimeout: 15000,
    include: ["tests/**/*.test.ts"],
    // DOM 用例使用 jsdom 的存储，避免 Node 原生 Web Storage 遮蔽浏览器实现。
    poolOptions: {
      forks: { execArgv: ["--no-experimental-webstorage"] },
    },
    testTransformMode: {
      web: [
        "**/base-dialog.test.ts",
      ],
    },
  },
});
