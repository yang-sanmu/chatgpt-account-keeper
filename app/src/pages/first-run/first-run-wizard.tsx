import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  connectAgent,
  inspectLegacy,
  importLegacy,
  checkDataRoot,
  useDataRoot,
  subscribeTauriEvents,
  normalizeApiError,
} from "@/ipc/bridge";
import { LegacyInspection, MigrationProgress, DataRootCheck } from "@/ipc/types";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AlertCircle, CheckCircle2, FolderOpen, Loader2, ArrowRight, Server, FileBox } from "lucide-react";
import { notify } from "@/lib/notify";
import { formatBytes } from "@/lib/format";


type WizardStep = "menu" | "legacy-inspect" | "legacy-import" | "data-root-check" | "restart-required";

/// 迁移阶段的中文名。
///
/// 后端发的是英文 slug（见 src/migration/ 的 reportMigration 调用）。直接显示会让用户在一个
/// 可能持续几分钟、动着几 GB 数据的过程里看到 "copy-profile" 这种字样，无法判断进展。
const MIGRATION_STAGES: Record<string, string> = {
  initializing: "准备导入",
  scan: "扫描旧数据",
  "scan-complete": "扫描完成",
  "verify-source": "校验旧数据完整性",
  "copy-preflight": "检查磁盘空间",
  "copy-profile": "复制 Chrome Profile",
  "verify-profile": "校验已复制的 Profile",
  "profiles-promoted": "启用新 Profile 目录",
  "build-database": "写入新数据库",
  "final-verification": "最终校验",
  completed: "已完成",
};

function describeStage(stage: string): string {
  return MIGRATION_STAGES[stage] ?? stage;
}

export function FirstRunWizard() {
  const [step, setStep] = useState<WizardStep>("menu");
  const [loading, setLoading] = useState(false);

  // 旧项目导入状态
  const [legacyPath, setLegacyPath] = useState<string>("");
  const [inspection, setInspection] = useState<LegacyInspection | null>(null);
  const [migrationState, setMigrationState] = useState<MigrationProgress | null>(null);

  // 数据目录检查结果
  const [dataRootCheck, setDataRootCheck] = useState<DataRootCheck | null>(null);

  // 迁移进度只在导入这一步订阅。
  //
  // 这个事件由 Rust 侧在 import_legacy 执行期间推送，store 没有订阅它（迁移是首次启动
  // 独有的流程）。离开这一步就注销，否则组件卸载后回调还在写一个已经不存在的 state。
  useEffect(() => {
    if (step !== "legacy-import") return;
    
    let unlisteners: (() => void)[] = [];
    let isMounted = true;
    
    subscribeTauriEvents({
      onMigration: (progress) => {
        if (isMounted) setMigrationState(progress);
      },
    }).then((unsubs) => {
      unlisteners = unsubs;
    });
    
    return () => {
      isMounted = false;
      unlisteners.forEach((u) => u());
    };
  }, [step]);

  // 路径 A：创建全新数据
  const handleCreateNew = async () => {
    setLoading(true);
    try {
      await connectAgent(true);
      // 连上之后 Rust 会推 bootstrap，store 自己就会切进主界面，这里不需要额外跳转。
    } catch (error) {
      notify.error("创建数据目录失败", error);
      setLoading(false);
    }
  };

  // 路径 B：预检并导入旧项目
  const handlePickLegacy = async () => {
    try {
      const selected = await open({ directory: true });
      if (!selected || typeof selected !== "string") return;
      
      setLoading(true);
      setLegacyPath(selected);
      const res = await inspectLegacy(selected);
      setInspection(res);
      setStep("legacy-inspect");
    } catch (error) {
      notify.error("预检旧项目失败", error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartImport = async () => {
    setStep("legacy-import");
    setMigrationState({ state: "running", stage: "initializing", message: "准备导入..." });
    try {
      await importLegacy(legacyPath);
      // 成功由 keeper://migration 的 complete 状态呈现，不在这里判定。
    } catch (e) {
      const err = normalizeApiError(e);
      setMigrationState({
        state: "failed",
        stage: "error",
        message: err.message,
        error: err
      });
    }
  };

  // 路径 C：指定数据目录
  const handlePickDataRoot = async () => {
    try {
      const selected = await open({ directory: true });
      if (!selected || typeof selected !== "string") return;
      
      setLoading(true);
      const res = await checkDataRoot(selected);
      setDataRootCheck(res);
      setStep("data-root-check");
    } catch (error) {
      notify.error("检查数据目录失败", error);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDataRoot = async () => {
    if (!dataRootCheck || !dataRootCheck.ok) return;
    setLoading(true);
    try {
      await useDataRoot(dataRootCheck.path);
      setStep("restart-required");
    } catch (error) {
      notify.error("设置数据目录失败", error);
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-app p-4 text-primary">
      <div className="w-full max-w-2xl">
        {step === "menu" && (
          <div className="space-y-6">
            <div className="text-center space-y-2 mb-8">
              <h1 className="text-3xl font-semibold tracking-tight">欢迎使用</h1>
              <p className="text-secondary text-lg">请选择数据初始化方式</p>
            </div>
            
            <Card className="hover:border-accent cursor-pointer transition-colors" onClick={handleCreateNew}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent-soft text-accent rounded-lg">
                    <Server className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">创建全新数据</CardTitle>
                    <CardDescription>在默认位置创建一个空的数据目录，适合新用户。</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card className="hover:border-accent cursor-pointer transition-colors" onClick={!loading ? handlePickLegacy : undefined}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent-soft text-accent rounded-lg">
                    <FileBox className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">导入旧版数据 (v1)</CardTitle>
                    <CardDescription>从 ChatGPT Account Keeper v1 版本的目录无损迁移数据。</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card className="hover:border-accent cursor-pointer transition-colors" onClick={!loading ? handlePickDataRoot : undefined}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent-soft text-accent rounded-lg">
                    <FolderOpen className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">选择已有或自定义数据目录</CardTitle>
                    <CardDescription>如果您将数据放在了其他位置（如便携设备），请选择该位置。</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </div>
        )}

        {step === "legacy-inspect" && inspection && (
          <Card>
            <CardHeader>
              <CardTitle>导入预览</CardTitle>
              <CardDescription className="break-all font-mono text-xs">{legacyPath}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!inspection.ok ? (
                <div className="p-4 bg-danger-soft text-danger rounded-md space-y-2">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertCircle className="size-4" />
                    <span>该目录似乎不是有效的数据目录</span>
                  </div>
                  <div className="text-sm">
                    <span className="font-mono rounded-chip border border-line bg-sunken px-1.5 py-0.5 text-[11px] text-secondary select-all">
                      {inspection.error?.code}
                    </span>
                    <span className="ml-2">{inspection.error?.message}</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-3 bg-sunken rounded-md flex flex-col gap-1">
                      <span className="text-xs text-secondary">账号数量</span>
                      <span className="font-medium">{inspection.counts?.accounts ?? 0}</span>
                    </div>
                    <div className="p-3 bg-sunken rounded-md flex flex-col gap-1">
                      <span className="text-xs text-secondary">Profiles</span>
                      <span className="font-medium">{inspection.counts?.profiles ?? 0}</span>
                    </div>
                    <div className="p-3 bg-sunken rounded-md flex flex-col gap-1">
                      <span className="text-xs text-secondary">分组</span>
                      <span className="font-medium">{inspection.counts?.groups ?? 0}</span>
                    </div>
                    <div className="p-3 bg-sunken rounded-md flex flex-col gap-1">
                      <span className="text-xs text-secondary">代理节点</span>
                      <span className="font-medium">{inspection.counts?.proxyNodes ?? 0}</span>
                    </div>
                  </div>
                  
                  {inspection.selectedProfilesDirectory && (
                    <p className="text-sm text-accent bg-accent-soft p-2 rounded-md">
                      提示：您选择了 profiles 子目录，已自动定位到父级项目目录。
                    </p>
                  )}
                  
                  {inspection.activeLocks && inspection.activeLocks.length > 0 && (
                    <div className="p-3 bg-warn-soft text-warn rounded-md space-y-2">
                      <div className="flex items-center gap-2 font-medium text-sm">
                        <AlertCircle className="size-4" />
                        <span>以下 Profile 正在被 Chrome 使用，将被跳过迁移。建议先关闭 Chrome 浏览器。</span>
                      </div>
                      <ul className="list-disc pl-5 text-sm">
                        {inspection.activeLocks.map(lock => (
                          <li key={lock.name}>{lock.name}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-sm text-secondary">
                    <span>
                      Profile 占用 {formatBytes(inspection.totalProfileBytes)}，
                      需要 {formatBytes(inspection.requiredBytes)} 空闲空间
                    </span>
                    {inspection.enoughSpace === false && (
                      <span className="flex items-center gap-1 text-danger">
                        <AlertCircle className="size-3" />
                        空闲空间不足（可用 {formatBytes(inspection.availableBytes)}）
                      </span>
                    )}
                    {/* null 表示**测不出**目标盘剩余空间，不等于空间不足。
                        这两种情况混在一起会让一台空间充裕的机器被拦住不能导入。 */}
                    {inspection.enoughSpace === null && (
                      <span className="text-warn">无法测定剩余空间，导入前请自行确认</span>
                    )}
                  </div>
                </>
              )}
            </CardContent>
            <CardFooter className="justify-end gap-2 border-t border-subtle pt-4">
              <Button variant="outline" onClick={() => setStep("menu")}>返回</Button>
              {inspection.ok && inspection.enoughSpace !== false && (
                <Button onClick={handleStartImport} disabled={loading}>
                  {loading && <Loader2 className="size-4 mr-2 animate-spin" />}
                  确认导入
                </Button>
              )}
            </CardFooter>
          </Card>
        )}

        {step === "legacy-import" && migrationState && (
          <Card>
            <CardHeader>
              <CardTitle>数据迁移中</CardTitle>
              <CardDescription>请勿关闭应用，这可能需要几分钟时间。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {migrationState.state === "failed" ? (
                <div className="space-y-3">
                  <div className="space-y-2 rounded-panel bg-danger-soft p-4 text-danger">
                    <div className="flex items-center gap-2 font-medium">
                      <AlertCircle className="size-4" />
                      <span>迁移失败</span>
                    </div>
                    <div className="text-sm">
                      <span className="select-all rounded-chip border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-secondary">
                        {migrationState.error?.code ?? "MIGRATION_FAILED"}
                      </span>
                      <span className="ml-2">
                        {migrationState.error?.message ?? migrationState.message}
                      </span>
                    </div>
                  </div>
                  {/* 这是用户此刻最担心的事，必须和错误本身分开、单独强调：迁移全程只读
                      旧目录，失败不会留下半个被改坏的旧项目。 */}
                  <div className="flex items-start gap-2 rounded-panel border border-ok-soft bg-ok-soft p-3 text-sm text-ok">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                    <span>
                      <strong>旧目录未被修改。</strong>
                      迁移只读取旧数据，你可以放心重试，或继续使用旧版本。
                    </span>
                  </div>
                </div>
              ) : migrationState.state === "complete" ? (
                <div className="flex flex-col items-center py-6 text-ok gap-3">
                  <CheckCircle2 className="size-12" />
                  <span className="text-lg font-medium">迁移完成！</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{describeStage(migrationState.stage)}</span>
                    <span className="tabular text-secondary">
                      {Math.round((migrationState.progress ?? 0) * 100)}%
                    </span>
                  </div>
                  <Progress value={(migrationState.progress ?? 0) * 100} />
                  <p className="text-xs text-secondary">{migrationState.message}</p>
                </div>
              )}
            </CardContent>
            <CardFooter className="justify-end border-t border-subtle pt-4">
              {migrationState.state === "failed" && (
                <Button onClick={() => setStep("menu")}>返回主菜单</Button>
              )}
              {migrationState.state === "complete" && (
                <Button onClick={() => connectAgent(true)}>进入应用 <ArrowRight className="size-4 ml-2" /></Button>
              )}
            </CardFooter>
          </Card>
        )}

        {step === "data-root-check" && dataRootCheck && (
          <Card>
            <CardHeader>
              <CardTitle>确认数据目录</CardTitle>
              <CardDescription className="break-all font-mono text-xs">{dataRootCheck.path}</CardDescription>
            </CardHeader>
            <CardContent>
              {!dataRootCheck.ok ? (
                <div className="p-4 bg-danger-soft text-danger rounded-md space-y-2">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertCircle className="size-4" />
                    <span>无法使用该目录</span>
                  </div>
                  <p className="text-sm">{dataRootCheck.reason}</p>
                </div>
              ) : (
                <div className="p-4 bg-sunken rounded-md text-sm space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-ok" />
                    <span>目录检查通过</span>
                  </div>
                  {dataRootCheck.initialized ? (
                    <p className="text-secondary">发现已有的应用数据，将继续使用该数据。</p>
                  ) : (
                    <p className="text-secondary">这是一个新目录，将在启动时初始化。</p>
                  )}
                  <p className="text-primary font-medium pt-2">确认后需要重启应用以生效。</p>
                </div>
              )}
            </CardContent>
            <CardFooter className="justify-end gap-2 border-t border-subtle pt-4">
              <Button variant="outline" onClick={() => setStep("menu")}>返回</Button>
              {dataRootCheck.ok && (
                <Button onClick={handleConfirmDataRoot} disabled={loading}>
                  {loading && <Loader2 className="size-4 mr-2 animate-spin" />}
                  确认并重启
                </Button>
              )}
            </CardFooter>
          </Card>
        )}

        {step === "restart-required" && (
          <Card>
            <CardHeader>
              <CardTitle>设置已保存</CardTitle>
            </CardHeader>
            <CardContent className="py-6 flex flex-col items-center gap-4 text-center">
              <CheckCircle2 className="size-12 text-ok" />
              <p>数据目录已更改，请完全退出并重新打开应用。</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
