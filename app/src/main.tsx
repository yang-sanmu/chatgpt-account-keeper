// 前端挂载入口。
//
// 主题在 React 挂载**之前**应用：放到 effect 里会先按默认 class 渲染一帧再切换，
// 在浅色系统上表现为一次深色闪屏。
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./lib/theme";
import "./styles/theme.css";

applyTheme("system");

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
