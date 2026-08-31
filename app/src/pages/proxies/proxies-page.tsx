import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { GroupsSection } from "./groups-section";
import { ProxiesSection } from "./proxies-section";

export function ProxiesPage() {
  return (
    <Page>
      <PageHeader
        title="分组与代理"
        description="管理账号分组、代理节点池以及订阅状态"
      />
      <PageBody className="pb-20 space-y-8">
        <GroupsSection />
        <ProxiesSection />
      </PageBody>
    </Page>
  );
}
