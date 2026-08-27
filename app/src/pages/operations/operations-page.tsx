import { useState } from "react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ListTodo, Copy } from "lucide-react";
import { shortId, formatDateTime, formatDuration } from "@/lib/format";
import { notify } from "@/lib/notify";

/// 任务筛选档位。定成常量数组是为了让 Tabs 的 onValueChange 能窄化回联合类型，
/// 而不是靠 as 断言 —— 断言在这里会静默接受任何字符串。
const OPERATION_FILTERS = ["active", "all", "succeeded", "failed", "cancelled"] as const;

type OperationFilter = (typeof OPERATION_FILTERS)[number];

const FILTER_LABELS: Record<OperationFilter, string> = {
  active: "进行中",
  all: "全部",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

function isOperationFilter(value: string): value is OperationFilter {
  return (OPERATION_FILTERS as readonly string[]).includes(value);
}

export function OperationsPage() {
  const operations = useKeeperStore((s) => s.operations);
  const [filter, setFilter] = useState<OperationFilter>("active");

  const filtered = operations.filter((op) => {
    if (filter === "all") return true;
    if (filter === "active") return op.state === "queued" || op.state === "running" || op.state === "waiting_user";
    if (filter === "succeeded") return op.state === "succeeded";
    if (filter === "failed") return op.state === "failed" || op.state === "timed_out";
    if (filter === "cancelled") return op.state === "cancelled";
    return true;
  });

  const handleCopyCode = (code: string) => {
    void navigator.clipboard.writeText(code);
    notify.success("已复制错误码");
  };

  const getBadgeVariant = (state: string) => {
    if (state === "succeeded") return "ok";
    if (state === "failed" || state === "timed_out") return "danger";
    if (state === "cancelled") return "neutral";
    return "accent";
  };

  const getStateLabel = (state: string) => {
    const map: Record<string, string> = {
      queued: "排队中",
      running: "运行中",
      waiting_user: "等待操作",
      succeeded: "已成功",
      failed: "已失败",
      timed_out: "已超时",
      cancelled: "已取消",
    };
    return map[state] || state;
  };

  return (
    <Page className="p-6">
      <PageHeader
        title="任务中心"
        description="查看并管理当前排队及历史执行的任务记录"
      />
      <div className="mb-6">
        <Tabs
          value={filter}
          onValueChange={(value) => {
            if (isOperationFilter(value)) setFilter(value);
          }}
        >
          <TabsList>
            {OPERATION_FILTERS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {FILTER_LABELS[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <PageBody className="pb-10 space-y-4">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<ListTodo />}
            title="暂无任务记录"
            description={operations.length === 0 ? "系统尚未执行任何任务。" : "当前筛选条件下没有匹配的任务。"}
          />
        ) : (
          filtered.map((op) => {
            const durationSec = op.finishedAt
              ? (new Date(op.finishedAt).getTime() - new Date(op.startedAt).getTime()) / 1000
              : op.state === "running"
              ? (Date.now() - new Date(op.startedAt).getTime()) / 1000
              : null;

            return (
              <Card key={op.id} className="p-4 flex flex-col gap-3 relative">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Badge variant={getBadgeVariant(op.state)}>{getStateLabel(op.state)}</Badge>
                    <span className="font-semibold text-primary">{op.kind}</span>
                    {op.resourceId && (
                      <span className="font-mono text-xs text-secondary bg-sunken px-1.5 py-0.5 rounded">
                        {shortId(op.resourceId)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted flex gap-4 tabular">
                    <span>{formatDateTime(op.startedAt)}</span>
                    {durationSec !== null && <span>耗时 {formatDuration(durationSec)}</span>}
                  </div>
                </div>

                <div className="text-sm text-secondary">
                  {op.stage ? <span className="font-medium text-primary mr-2">[{op.stage}]</span> : null}
                  {op.message || "无详细信息"}
                </div>

                {op.error?.code && (
                  <div className="flex items-center mt-1">
                    <button
                      onClick={() => handleCopyCode(op.error!.code)}
                      className="inline-flex items-center gap-1 rounded-chip border border-line bg-sunken px-1.5 py-0.5 text-[11px] text-secondary hover:text-primary hover:border-subtle transition-colors cursor-pointer font-mono"
                      title="点击复制错误码"
                    >
                      {op.error.code}
                      <Copy className="size-3" />
                    </button>
                  </div>
                )}

                {op.progress !== null && (op.state === "queued" || op.state === "running" || op.state === "waiting_user") && (
                  <div className="mt-2">
                    <Progress value={op.progress * 100} />
                  </div>
                )}
              </Card>
            );
          })
        )}
      </PageBody>
    </Page>
  );
}
