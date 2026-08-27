import * as React from "react";
import { useKeeperStore } from "@/store/keeperStore";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { FolderGit2, Plus, Edit2, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GroupDialog } from "./group-dialog";
import { GroupDeleteDialog } from "./group-delete-dialog";
import type { Group } from "@/ipc/types";

export function GroupsSection() {
  const groups = useKeeperStore((s) => s.groups);
  const proxies = useKeeperStore((s) => s.proxies);

  const [dialogState, setDialogState] = React.useState<
    { mode: "create" } | { mode: "edit"; group: Group } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Group | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-primary">账号分组</h2>
        <Button onClick={() => setDialogState({ mode: "create" })} variant="outline" size="sm">
          <Plus className="size-4 mr-2" />
          新建分组
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 />}
          title="暂无分组"
          description="使用分组可以将账号绑定到特定代理节点，并统一时区与语言环境。"
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4 items-start">
          {groups.map((group) => {
            const proxyNode = group.proxyId 
              ? proxies.nodes.find((n) => n.id === group.proxyId)
              : null;

            return (
              <Card key={group.id} className="flex flex-col transition-colors hover:border-subtle">
                <CardHeader className="pb-2">
                  <CardTitle className="truncate text-base" title={group.name}>
                    {group.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 pb-3 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="text-muted">绑定节点</span>
                    <span className="text-primary truncate" title={proxyNode?.name || "未绑定"}>
                      {group.proxyId ? (proxyNode?.name || group.proxyId) : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted">时区</span>
                    <span className="text-primary tabular truncate">
                      {group.timezone || "系统默认"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted">语言</span>
                    <span className="text-primary tabular truncate">
                      {group.locale || "系统默认"}
                    </span>
                  </div>
                </CardContent>
                <CardFooter className="p-2 border-t border-subtle bg-sunken/50 justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDialogState({ mode: "edit", group })}
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
                        onClick={() => setDeleteTarget(group)}
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
            );
          })}
        </div>
      )}

      <GroupDialog state={dialogState} onClose={() => setDialogState(null)} />
      <GroupDeleteDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}
