import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 在开发模式下用 devUrl 指向这个 dev server，发布构建只用 frontendDist。
// 固定端口是必须的：Tauri 的 devUrl 是写死的，随机端口会连不上。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
