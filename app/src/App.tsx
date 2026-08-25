// 应用主入口组件
// 负责协调首次启动向导、主 Shell 布局（左侧栏 + 右侧内容区）与全局浮层

import React from "react";
import { AppProvider, useApp } from "./state/AppContext";
import { Sidebar } from "./components/Layout/Sidebar";
import { Header } from "./components/Layout/Header";
import { ToastContainer } from "./components/Toast/ToastContainer";
import { LoginProgressModal } from "./components/Modals/LoginProgressModal";
import { CloseConfirmModal } from "./components/Modals/CloseConfirmModal";
import { UpdateModal } from "./components/Modals/UpdateModal";
import { FirstRunWizard } from "./pages/FirstRun/FirstRunWizard";

// 八个业务功能页面
import { OverviewPage } from "./pages/Overview/OverviewPage";
import { AccountsPage } from "./pages/Accounts/AccountsPage";
import { OperationsPage } from "./pages/Operations/OperationsPage";
import { ProxiesPage } from "./pages/Proxies/ProxiesPage";
import { ConversationsPage } from "./pages/Conversations/ConversationsPage";
import { ProfilesPage } from "./pages/Profiles/ProfilesPage";
import { HistoryPage } from "./pages/History/HistoryPage";
import { SettingsPage } from "./pages/Settings/SettingsPage";

/// 页面内容：加载中、首次启动向导，或八页 Shell。
///
/// 全局浮层**不在**这里。它们必须挂在这个组件之外，因为这里会提前 return —— 关闭确认框
/// 曾经因此在首次启动页上不存在，导致窗口点关闭毫无反应，只能去任务管理器结束进程。
const PageContent: React.FC = () => {
  const { startupInfo, isInitializing, activeTab } = useApp();

  // 启动加载中占位
  if (isInitializing) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "var(--bg-app)",
          color: "var(--text-secondary)",
          fontSize: "14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "18px",
              height: "18px",
              border: "2px solid var(--color-primary)",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
            }}
          />
          <span>正在启动 ChatGPT Account Keeper...</span>
        </div>
      </div>
    );
  }

  // 首次启动流程：数据目录未建库时走向导页
  if (startupInfo && !startupInfo.initialized) {
    return (
      <FirstRunWizard
        onComplete={() => {
          window.location.reload();
        }}
      />
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", overflow: "hidden" }}>
      {/* 左侧导航栏 */}
      <Sidebar />

      {/* 右侧主内容区 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          height: "100%",
          overflow: "hidden",
        }}
      >
        <Header />

        {/* 动态渲染八个页面之一（由 useState 维护 activeTab） */}
        <main style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {activeTab === "overview" && <OverviewPage />}
          {activeTab === "accounts" && <AccountsPage />}
          {activeTab === "operations" && <OperationsPage />}
          {activeTab === "proxies" && <ProxiesPage />}
          {activeTab === "conversations" && <ConversationsPage />}
          {activeTab === "profiles" && <ProfilesPage />}
          {activeTab === "history" && <HistoryPage />}
          {activeTab === "settings" && <SettingsPage />}
        </main>
      </div>

    </div>
  );
};

/// 全局浮层。
///
/// 与 PageContent 同级而不是嵌在里面：PageContent 在加载中和首次启动时会提前 return，
/// 嵌进去的浮层就会在那两种状态下不存在。关闭确认框缺席的后果是窗口关不掉 —— Rust 侧
/// 对 CloseRequested 调了 prevent_close()，把决定权完全交给前端。
const GlobalOverlays: React.FC = () => {
  const {
    activeLogin,
    closeActiveLogin,
    updateModalState,
    installAppUpdate,
    closeUpdateModal,
    closeModalOpen,
    handleMinimizeToTray,
    handleExitAll,
    closeCloseModal,
  } = useApp();

  return (
    <>
      <ToastContainer />

      <LoginProgressModal
        isOpen={activeLogin !== null}
        onClose={closeActiveLogin}
        accountId={activeLogin?.accountId ?? null}
        accountEmail={activeLogin?.accountEmail}
        accountNote={activeLogin?.accountNote}
        operation={activeLogin?.operation ?? null}
      />

      <CloseConfirmModal
        isOpen={closeModalOpen}
        onClose={closeCloseModal}
        onMinimizeToTray={handleMinimizeToTray}
        onExitAll={handleExitAll}
      />

      <UpdateModal
        isOpen={updateModalState.isOpen}
        onClose={closeUpdateModal}
        status={updateModalState.status}
        onInstall={installAppUpdate}
        installing={updateModalState.installing}
      />
    </>
  );
};

export const App: React.FC = () => {
  return (
    <AppProvider>
      <PageContent />
      <GlobalOverlays />
    </AppProvider>
  );
};
