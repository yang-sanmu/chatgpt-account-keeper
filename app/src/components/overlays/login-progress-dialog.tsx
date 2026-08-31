import { useKeeperStore } from "@/store/keeperStore";
import { useShallow } from "zustand/react/shallow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { displayEmail } from "@/lib/format";

/// 操作终态。必须与 store 里的 TERMINAL_OPERATION_STATES 一致 —— 漏掉 timed_out 会让一个
/// 已经超时结束的登录在界面上永远转圈。
const TERMINAL_STATES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

export function LoginProgressDialog() {
  const { login, closeLogin, emailsRevealed } = useKeeperStore(
    useShallow((state) => ({
      login: state.login,
      closeLogin: state.closeLogin,
      emailsRevealed: state.emailsRevealed,
    }))
  );

  const operation = login?.operation ?? null;
  const state = operation?.state;

  const waitingUser = state === "waiting_user";
  const terminal = state !== undefined && TERMINAL_STATES.has(state);
  const succeeded = state === "succeeded";
  const failed = terminal && !succeeded;

  const percent =
    typeof operation?.progress === "number"
      ? Math.round(operation.progress * 100)
      : null;

  return (
    <Dialog open={login !== null} onOpenChange={(next) => !next && closeLogin()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {succeeded && <CheckCircle2 className="size-4 text-ok" />}
            {failed && <TriangleAlert className="size-4 text-danger" />}
            {succeeded ? "登录完成" : failed ? "登录未完成" : "正在登录"}
          </DialogTitle>
          <DialogDescription>
            {displayEmail(login?.accountEmail, emailsRevealed)}
            {login?.accountNote ? ` · ${login.accountNote}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex items-center gap-2 text-base text-primary">
            {!terminal && !waitingUser && (
              <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
            )}
            <span className="flex-1">
              {operation?.message ?? (waitingUser ? "等待你在浏览器中完成操作" : "正在启动浏览器")}
            </span>
            {percent !== null && !terminal && (
              <span className="tabular text-xs text-muted">{percent}%</span>
            )}
          </div>

          {/* waiting_user 必须显式呈现：这一步要用户去一个**另外的** Chrome 窗口里操作，
              只说「已提交」的话用户会盯着这个弹窗等一个永远不会自己走完的进度。 */}
          {waitingUser && (
            <div className="flex items-start gap-2.5 rounded-panel border border-warn-soft bg-warn-soft p-3 text-base text-warn">
              <ExternalLink className="mt-0.5 size-4 shrink-0" />
              <div className="flex flex-col gap-1">
                <span className="font-medium">需要你在 Chrome 窗口里操作</span>
                <span className="text-secondary">
                  已经打开了一个真实的 Chrome 窗口。请在那里完成登录、验证码或人机校验；
                  完成后这里会自动继续，不需要回来点任何按钮。
                </span>
              </div>
            </div>
          )}

          {percent !== null && !terminal && !waitingUser && <Progress value={percent} />}

          {/* 失败时把稳定错误码显示出来。它是用户报障时唯一有用的信息。 */}
          {failed && operation?.error && (
            <div className="flex flex-col gap-1.5 rounded-panel border border-danger-soft bg-danger-soft p-3 text-base">
              <span className="text-primary">{operation.error.message}</span>
              <code className="w-fit rounded-chip border border-line bg-sunken px-1.5 py-0.5 font-mono text-xs text-secondary">
                {operation.error.code}
              </code>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant={terminal ? "default" : "outline"} onClick={closeLogin}>
            {/* 未结束时关掉弹窗不会取消登录，任务继续在后台跑，所以措辞不能是「取消」。 */}
            {terminal ? "关闭" : "转到后台继续"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
