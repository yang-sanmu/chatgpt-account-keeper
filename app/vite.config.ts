import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Tauri 在开发模式下用 devUrl 指向这个 dev server，发布构建只用 frontendDist。
// 固定端口是必须的：Tauri 的 devUrl 是写死的，随机端口会连不上。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri 由 cargo 自己监视，Vite 重复监视会在 Windows 上抢文件句柄。
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // WebView2 / WKWebView / WebKitGTK 4.1 都支持的基线。
    target: "es2022",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
    // 这个包从本地磁盘加载，没有网络往返，500kB 的默认告警阈值是给网站定的。
    // 拆分反而有害：切页面时会多一次动态 import，表现为一下白屏。
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
