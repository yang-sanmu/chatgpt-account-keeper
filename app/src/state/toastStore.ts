// 全局 Toast 通知管理模块
// 支持 success / error / info 三类。失败信息停留更久并提供可复制的稳定错误码

import type { ApiError } from "../ipc/types";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  code?: string;
  durationMs: number;
}

type ToastListener = (toasts: ToastItem[]) => void;

class ToastManager {
  private toasts: ToastItem[] = [];
  private listeners: Set<ToastListener> = new Set();

  public subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener);
    listener([...this.toasts]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const copy = [...this.toasts];
    for (const listener of this.listeners) {
      listener(copy);
    }
  }

  public show(options: {
    type?: ToastType;
    title: string;
    message?: string;
    code?: string;
    durationMs?: number;
  }): string {
    const id = "toast-" + Math.random().toString(36).substring(2, 9);
    const type = options.type ?? "info";
    // 错误通知停留更久（8 秒），其余类型默认 3.5 秒
    const durationMs =
      options.durationMs ?? (type === "error" ? 8000 : 3500);

    const item: ToastItem = {
      id,
      type,
      title: options.title,
      message: options.message,
      code: options.code,
      durationMs,
    };

    this.toasts.push(item);
    this.notify();

    if (durationMs > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, durationMs);
    }

    return id;
  }

  public success(title: string, message?: string): string {
    return this.show({ type: "success", title, message });
  }

  public error(title: string, error?: unknown): string {
    let code: string | undefined;
    let message: string | undefined;

    if (typeof error === "object" && error !== null) {
      const err = error as Partial<ApiError>;
      if (err.code) code = err.code;
      if (err.message) message = err.message;
    } else if (typeof error === "string") {
      message = error;
    }

    return this.show({
      type: "error",
      title,
      message,
      code,
      durationMs: 8000,
    });
  }

  public warning(title: string, message?: string): string {
    return this.show({ type: "warning", title, message });
  }

  public info(title: string, message?: string): string {
    return this.show({ type: "info", title, message });
  }

  public dismiss(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }
}

export const toast = new ToastManager();
