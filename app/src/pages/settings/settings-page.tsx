import { Page, PageBody, PageHeader } from "@/components/layout/page";
import { AgentSettingsCard } from "./agent-settings-card";
import { DesktopSettingsCard } from "./desktop-settings-card";
import { AboutCard } from "./about-card";

export function SettingsPage() {
  return (
    <Page>
      <PageHeader
        title="设置"
        description="管理客户端偏好与调度器行为配置。"
      />
      <PageBody className="flex flex-col gap-6">
        <AgentSettingsCard />
        <DesktopSettingsCard />
        <AboutCard />
      </PageBody>
    </Page>
  );
}
