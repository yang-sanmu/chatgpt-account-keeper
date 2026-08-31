import * as React from "react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { MessageSquare, Plus, Edit2, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConversationDialog } from "./conversation-dialog";
import { ConversationDeleteDialog } from "./conversation-delete-dialog";
import type { ConversationSet } from "@/ipc/types";

export function ConversationsPage() {
  const conversations = useKeeperStore((s) => s.conversations);
  const entries = Object.entries(conversations);

  const [dialogState, setDialogState] = React.useState<
    | { mode: "create" }
    | { mode: "edit"; name: string; set: ConversationSet }
    | null
  >(null);

  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);

  return (
    <Page>
      <PageHeader
        title="会话策略"
        description="管理对话的主题与轮数规则，分配给账号以实现不同的对话行为"
      >
        <Button onClick={() => setDialogState({ mode: "create" })}>
          <Plus className="size-4 mr-2" />
          新建策略
        </Button>
      </PageHeader>

      <PageBody className="pb-20">
        {entries.length === 0 ? (
          <EmptyState
            icon={<MessageSquare />}
            title="暂无会话策略"
            description="您还没有添加任何会话策略，立即创建一个来定制对话行为。"
            action={
              <Button onClick={() => setDialogState({ mode: "create" })}>新建策略</Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4 items-start">
            {entries.map(([name, set]) => (
              <Card key={name} className="flex flex-col transition-colors hover:border-subtle">
                <CardHeader className="pb-2">
                  <CardTitle className="truncate text-base" title={name}>
                    {name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 pb-3">
                  <div className="flex justify-between items-start text-sm">
                    <span className="text-muted shrink-0 w-16">主题</span>
                    <span className="text-primary text-right truncate" title={set.topic}>
                      {set.topic}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted shrink-0 w-16">对话轮数</span>
                    <span className="text-primary tabular">
                      {set.minRounds} - {set.maxRounds} 轮
                    </span>
                  </div>
                </CardContent>
                <CardFooter className="p-2 border-t border-subtle bg-sunken/50 justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDialogState({ mode: "edit", name, set })}
                        aria-label="编辑"
                      >
                        <Edit2 className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>编辑</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDeleteTarget(name)}
                        className="text-danger hover:text-danger-content hover:bg-danger"
                        aria-label="删除"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>删除</TooltipContent>
                  </Tooltip>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </PageBody>

      <ConversationDialog
        state={dialogState}
        onClose={() => setDialogState(null)}
      />

      <ConversationDeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
    </Page>
  );
}
