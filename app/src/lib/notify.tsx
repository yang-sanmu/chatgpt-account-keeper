// 通知发送口。
//
// 包一层而不是各处直接调 sonner，是为了让「失败必须显示可复制的稳定错误码」这条规则只有
// 一个实现点。错误码是用户报障时唯一有用的信息，散到几十个 catch 里必然会漏。

import { toast as sonnerToast } from "sonner";
import { ERROR_MESSAGES } from "@/ipc/constants";
import type { ApiError } from "@/ipc/types";

/// 错误提示停留更久：8 秒。用户需要时间读完并复制错误码。
const ERROR_DURATION_MS = 8000;
const DEFAULT_DURATION_MS = 3500;

/// 从任意抛出物里取出稳定错误码与可读信息。
export function describeError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const raw = error as Partial<ApiError>;
    const code = typeof raw.code === "string" && raw.code.length > 0 ? raw.code : "INTERNAL";
    const message =
      typeof raw.message === "string" && raw.message.length > 0
        ? raw.message
        : (ERROR_MESSAGES[code] ?? "发生了未知错误");
    return { code, message };
  }
  if (typeof error === "string" && error.length > 0) {
    return { code: "INTERNAL", message: error };
  }
  return { code: "INTERNAL", message: "发生了未知错误" };
}

/// 错误描述 + 可点击复制的错误码徽章。
///
/// 做成组件而不是把错误码拼进文本，是因为用户需要**精确**复制它：从一句中文里选中
/// `PROFILE_IN_USE` 而不带上周围的标点，在一个 3 秒后消失的提示里几乎做不到。
function ErrorDetail({ message, code }: { message: string; code: string }): React.ReactElement {
  return (
    <span className="flex flex-col items-start gap-1.5">
      <span>{message}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code);
        }}
        title="点击复制错误码"
        className="rounded-chip border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-secondary transition-colors hover:bg-hover hover:text-primary"
      >
        {code}
      </button>
    </span>
  );
}

export const notify = {
  success(title: string, description?: string): void {
    sonnerToast.success(title, { description, duration: DEFAULT_DURATION_MS });
  },

  info(title: string, description?: string): void {
    sonnerToast.info(title, { description, duration: DEFAULT_DURATION_MS });
  },

  warning(title: string, description?: string): void {
    sonnerToast.warning(title, { description, duration: DEFAULT_DURATION_MS });
  },

  /// 失败提示。第二个参数可以是抛出物（自动提取并展示错误码）或一段说明文字。
  error(title: string, detail?: unknown): void {
    if (detail === undefined) {
      sonnerToast.error(title, { duration: ERROR_DURATION_MS });
      return;
    }
    if (typeof detail === "string") {
      sonnerToast.error(title, { description: detail, duration: ERROR_DURATION_MS });
      return;
    }
    const { code, message } = describeError(detail);
    sonnerToast.error(title, {
      description: <ErrorDetail message={message} code={code} />,
      duration: ERROR_DURATION_MS,
    });
  },
};
