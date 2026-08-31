import { LoginProgressDialog } from "./login-progress-dialog";
import { CloseConfirmDialog } from "./close-confirm-dialog";
import { UpdateDialog } from "./update-dialog";
import { ExitProgressDialog } from "./exit-progress-dialog";
import { SchedulerStartDialog } from "./scheduler-start-dialog";
import { Toaster } from "@/components/ui/toaster";

export function GlobalOverlays() {
  return (
    <>
      <LoginProgressDialog />
      <CloseConfirmDialog />
      <UpdateDialog />
      <ExitProgressDialog />
      <SchedulerStartDialog />
      <Toaster />
    </>
  );
}
