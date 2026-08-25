//! 应用状态与事件泵。
//!
//! 事件泵把 IPC 层的 `Notification` 转成 Tauri 事件发给前端。连续性丢失时它**自己**取
//! 一次全量 `system.bootstrap` 再推给前端——前端不能调 bootstrap，也不该知道什么时候
//! 该取。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::agent::launcher::Launcher;
use crate::ipc::client::Notification;
use crate::ipc::connection::{Connection, ConnectionSnapshot, RECONNECT_BACKOFF_SECONDS};
use crate::paths::AppPaths;
use crate::settings::DesktopSettings;
use crate::update::UpdatePrompts;

/// 前端订阅的事件名。
pub mod events {
    /// Agent 推来的一条业务事件（原样透传 name + payload）。
    pub const AGENT_EVENT: &str = "keeper://agent-event";
    /// 连接状态变化。
    pub const CONNECTION: &str = "keeper://connection";
    /// 全量快照（首次连上、seq 缺口、实例变化之后）。
    pub const BOOTSTRAP: &str = "keeper://bootstrap";
    /// 迁移进度。
    pub const MIGRATION: &str = "keeper://migration";
    /// 更新状态。
    pub const UPDATE: &str = "keeper://update";
    /// 退出进度。Agent 的关闭是 16 步、上限 20 秒的流程，必须让用户看到在做什么。
    pub const EXIT: &str = "keeper://exit";
}

pub struct AppState {
    pub paths: AppPaths,
    pub connection: Arc<Connection>,
    pub launcher: Arc<Launcher>,
    pub settings: tokio::sync::Mutex<DesktopSettings>,
    pub prompts: tokio::sync::Mutex<UpdatePrompts>,
    /// 已下载待安装的更新包。只在一次安装流程内存活。
    pub staged_update: tokio::sync::Mutex<Option<StagedUpdate>>,
    /// 「退出全部」进行中：抑制重连，否则退出会把 Agent 又拉起来。
    pub suppress_reconnect: std::sync::atomic::AtomicBool,
    /// 退出流程已经开始。用户在等待期间反复点击不该叠出多条关闭流程。
    pub exiting: std::sync::atomic::AtomicBool,
    notifications: mpsc::UnboundedSender<Notification>,
}

pub struct StagedUpdate {
    pub version: String,
    pub bytes: Vec<u8>,
}

impl AppState {
    pub fn new(
        paths: AppPaths,
        connection: Arc<Connection>,
        launcher: Arc<Launcher>,
        settings: DesktopSettings,
        notifications: mpsc::UnboundedSender<Notification>,
    ) -> Self {
        let prompts = UpdatePrompts::with_ignored(settings.ignored_update_version.as_deref());
        Self {
            paths,
            connection,
            launcher,
            settings: tokio::sync::Mutex::new(settings),
            prompts: tokio::sync::Mutex::new(prompts),
            staged_update: tokio::sync::Mutex::new(None),
            suppress_reconnect: std::sync::atomic::AtomicBool::new(false),
            exiting: std::sync::atomic::AtomicBool::new(false),
            notifications,
        }
    }

    pub fn notifications(&self) -> mpsc::UnboundedSender<Notification> {
        self.notifications.clone()
    }

    /// 连接（必要时启动 Agent），成功后取一次全量快照推给前端。
    pub async fn connect_and_bootstrap(
        &self,
        app: &AppHandle,
        start_when_unavailable: bool,
    ) -> ConnectionSnapshot {
        let launcher = Arc::clone(&self.launcher);
        let endpoint = self.connection.endpoint().clone();
        let snapshot = self
            .connection
            .ensure_connected(start_when_unavailable, self.notifications(), || {
                launcher
                    .start(&endpoint, None)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .await;

        let _ = app.emit(events::CONNECTION, &snapshot);
        if snapshot.connected {
            self.push_bootstrap(app).await;
        }
        snapshot
    }

    /// 取一次全量快照并推给前端。
    pub async fn push_bootstrap(&self, app: &AppHandle) {
        match self
            .connection
            .call_internal("system.bootstrap", serde_json::json!({}), None)
            .await
        {
            Ok(snapshot) => {
                let _ = app.emit(events::BOOTSTRAP, snapshot);
            }
            Err(error) => {
                let _ = app.emit(
                    events::CONNECTION,
                    ConnectionSnapshot {
                        connected: self.connection.is_connected().await,
                        status: "同步失败".into(),
                        detail: error.to_string(),
                        agent_version: None,
                        instance_id: None,
                    },
                );
            }
        }
    }
}

/// 事件泵。在 setup 里 spawn 一次，活到进程结束。
pub fn spawn_event_pump(
    app: AppHandle,
    state: Arc<AppState>,
    mut notifications: mpsc::UnboundedReceiver<Notification>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(notification) = notifications.recv().await {
            match notification {
                Notification::Event(event) => {
                    let _ = app.emit(events::AGENT_EVENT, &event);
                }
                Notification::ContinuityLost => {
                    // 序号缺口或实例变化：本地增量状态已经不可信，唯一正确的动作是
                    // 取一次全量快照。这个判断必须在这里而不是前端——前端被 reload
                    // 之后无法知道自己错过了什么。
                    state.push_bootstrap(&app).await;
                }
                Notification::Disconnected(failure) => {
                    let detail = failure.unwrap_or_else(|| "Agent 已关闭 IPC 连接".to_string());
                    let _ = app.emit(
                        events::CONNECTION,
                        ConnectionSnapshot {
                            connected: false,
                            status: "连接已断开".into(),
                            detail,
                            agent_version: None,
                            instance_id: None,
                        },
                    );
                    spawn_reconnect(app.clone(), Arc::clone(&state));
                }
            }
        }
    });
}

/// 断线重连。只在数据目录已经初始化过时尝试——数据库不存在说明还没走首次启动流程。
fn spawn_reconnect(app: AppHandle, state: Arc<AppState>) {
    use std::sync::atomic::Ordering;
    if state.suppress_reconnect.load(Ordering::Acquire) {
        return;
    }
    if !state.paths.data_directory_initialized() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        for delay in RECONNECT_BACKOFF_SECONDS {
            tokio::time::sleep(std::time::Duration::from_secs(*delay)).await;
            if state.suppress_reconnect.load(Ordering::Acquire) {
                return;
            }
            if state.connection.is_connected().await {
                return;
            }
            let snapshot = state.connect_and_bootstrap(&app, true).await;
            if snapshot.connected {
                return;
            }
        }
    });
}

/// 迁移进度监视。只在带 `--legacy-root` 启动 Agent 时用。
pub fn spawn_migration_watch(app: AppHandle, progress_file: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let mut last = None;
        // 迁移可能持续很久（2.6 GB Profile 复制）。上限 10 分钟无变化就停止监视，
        // 真正的完成/失败判定由连接轮询和进程存活检查负责。
        let mut idle_ticks = 0u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            match crate::agent::migration::read(&progress_file, &mut last, false) {
                Some(progress) => {
                    idle_ticks = 0;
                    let complete = progress.is_complete() || progress.is_failed();
                    let _ = app.emit(crate::state::events::MIGRATION, &progress);
                    if complete {
                        return;
                    }
                }
                None => {
                    idle_ticks += 1;
                    if idle_ticks > 2400 {
                        return;
                    }
                }
            }
        }
    });
}
