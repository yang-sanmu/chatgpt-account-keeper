import { useEffect } from "react";
import { useKeeperStore } from "@/store/keeperStore";
import { useShallow } from "zustand/react/shallow";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GlobalOverlays } from "@/components/overlays";
import { AppShell } from "@/components/layout/app-shell";
import { PagePlaceholder } from "@/pages/placeholder";
import { AccountsPage } from "@/pages/accounts/accounts-page";
import { OverviewPage } from "@/pages/overview/overview-page";
import { OperationsPage } from "@/pages/operations/operations-page";
import { HistoryPage } from "@/pages/history/history-page";
import { ProxiesPage } from "@/pages/proxies/proxies-page";
import { ConversationsPage } from "@/pages/conversations/conversations-page";
import { ProfilesPage } from "@/pages/profiles/profiles-page";
import { SettingsPage } from "@/pages/settings/settings-page";
import { FirstRunWizard } from "@/pages/first-run/first-run-wizard";
import { Loader2 } from "lucide-react";

function AppContent() {
  const { initializing, startupInfo, nav } = useKeeperStore(
    useShallow((state) => ({
      initializing: state.initializing,
      startupInfo: state.startupInfo,
      nav: state.nav,
    }))
  );

  if (initializing) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-app text-muted">
        <Loader2 className="size-8 animate-spin" />
      </div>
    );
  }

  if (startupInfo && !startupInfo.initialized) {
    return <FirstRunWizard />;
  }

  // Map nav keys to their localized names for the placeholder
  const navNames: Record<string, string> = {
    settings: "设置",
  };

  return (
    <AppShell>
      {nav === "overview" ? (
        <OverviewPage />
      ) : nav === "accounts" ? (
        <AccountsPage />
      ) : nav === "operations" ? (
        <OperationsPage />
      ) : nav === "history" ? (
        <HistoryPage />
      ) : nav === "proxies" ? (
        <ProxiesPage />
      ) : nav === "conversations" ? (
        <ConversationsPage />
      ) : nav === "profiles" ? (
        <ProfilesPage />
      ) : nav === "settings" ? (
        <SettingsPage />
      ) : (
        <PagePlaceholder name={navNames[nav] || nav} />
      )}
    </AppShell>
  );
}

export function App() {
  const { bootstrapApp, teardown, theme } = useKeeperStore(
    useShallow((state) => ({
      bootstrapApp: state.bootstrapApp,
      teardown: state.teardown,
      theme: state.desktopSettings.theme,
    }))
  );

  // Bootstrap
  useEffect(() => {
    void bootstrapApp();
    return () => teardown();
  }, [bootstrapApp, teardown]);

  // Theme application
  useEffect(() => {
    applyTheme(theme);
    if (theme === "system") {
      const unsubscribe = watchSystemTheme(() => applyTheme("system"));
      return unsubscribe;
    }
  }, [theme]);

  return (
    <TooltipProvider>
      {/* 
        CRITICAL: GlobalOverlays must render at the same level as AppContent, 
        and not inside it. If nested inside AppContent, early returns for 
        initializing/first-run would cause overlays (like close confirm dialog) 
        to be unmounted, making the app unclosable.
      */}
      <GlobalOverlays />
      <AppContent />
    </TooltipProvider>
  );
}
