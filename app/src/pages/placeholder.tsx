import { Page, PageBody, PageHeader } from "@/components/layout/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Hammer } from "lucide-react";

/// UI 重建期间的占位页。每完成一个真实页面就替换掉对应的这一个。
export function PagePlaceholder({ name }: { name: string }) {
  return (
    <Page className="p-6">
      <PageHeader title={name} />
      <PageBody>
        <EmptyState
          icon={<Hammer />}
          title={`${name}页面还在重建中`}
          description="界面正在逐页重做，这一页尚未完成。其它已完成的页面可以正常使用。"
        />
      </PageBody>
    </Page>
  );
}
