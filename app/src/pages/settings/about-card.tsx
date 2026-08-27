import { useKeeperStore } from "@/store/keeperStore";
import { useShallow } from "zustand/react/shallow";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function AboutCard() {
  const { startupInfo, connection, checkForUpdate } = useKeeperStore(
    useShallow((state) => ({
      startupInfo: state.startupInfo,
      connection: state.connection,
      checkForUpdate: state.checkForUpdate,
    }))
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>关于与许可</CardTitle>
        <CardDescription>应用版本、数据存储路径与开源协议信息。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[120px_1fr] items-baseline gap-4">
            <Label className="text-secondary text-right">客户端版本</Label>
            <div className="flex items-center gap-4">
              <span className="text-sm">{startupInfo?.version ?? "未知"}</span>
              <Button variant="outline" size="sm" onClick={() => void checkForUpdate()}>
                检查更新
              </Button>
            </div>
          </div>
          
          <div className="grid grid-cols-[120px_1fr] items-baseline gap-4">
            <Label className="text-secondary text-right">核心服务版本</Label>
            <span className="text-sm">{connection.agentVersion ?? "未连接"}</span>
          </div>

          <div className="grid grid-cols-[120px_1fr] items-baseline gap-4">
            <Label className="text-secondary text-right">IPC 协议版本</Label>
            <span className="text-sm">v1</span>
          </div>

          <div className="grid grid-cols-[120px_1fr] items-baseline gap-4">
            <Label className="text-secondary text-right">许可协议</Label>
            <span className="text-sm">GNU AGPLv3</span>
          </div>

          <div className="grid grid-cols-[120px_1fr] items-baseline gap-4">
            <Label className="text-secondary text-right">数据目录</Label>
            <span className="text-sm break-all font-mono text-[13px]">{startupInfo?.dataDirectory ?? "未知"}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
