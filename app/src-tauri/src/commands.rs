//! 前端可见的 Tauri command。
//!
//! 只有一个通用桥接 `agent_call`，加上几个 Rust 独占能力的入口（连接、更新、退出、
//! 数据目录、迁移）。不为每个 IPC 方法造一个 command——那只是把 45 个方法名换个地方
//! 再写一遍。

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::ipc::connection::ConnectionSnapshot;
use crate::settings::{self, DesktopSettings};
use crate::state::{events, AppState};
use crate::update::InstallStage;

/// 前端可见的错误。稳定错误码原样透出——用户和日志都靠它定位问题。
#[derive(Debug, serde::Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ApiError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL".into(),
            message: message.into(),
            retryable: false,
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "VALIDATION_FAILED".into(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl From<crate::ipc::client::CallError> for ApiError {
    fn from(error: crate::ipc::client::CallError) -> Self {
        use crate::ipc::client::CallError;
        match error {
            CallError::Agent(agent) => Self {
                code: agent.code,
                message: agent.message,
                retryable: agent.retryable,
            },
            CallError::NotConnected => Self {
                code: "AGENT_NOT_CONNECTED".into(),
                message: "尚未连接 Agent".into(),
                retryable: true,
            },
            CallError::Timeout(method) => Self {
                code: "AGENT_TIMEOUT".into(),
                message: format!("请求超时：{method}"),
                retryable: true,
            },
            other => Self::internal(other.to_string()),
        }
    }
}

/// 通用 IPC 桥接。方法名必须在 UI 白名单内（45 项业务方法）。
#[tauri::command]
pub async fn agent_call(
    state: State<'_, Arc<AppState>>,
    method: String,
    params: Option<serde_json::Value>,
    command_id: Option<String>,
) -> Result<serde_json::Value, ApiError> {
    state
        .connection
        .call_from_ui(&method, params.unwrap_or(serde_json::json!({})), command_id)
        .await
        .map_err(ApiError::from)
}

/// 生成一个幂等键。变更类调用要带它：Agent 把结果留 24 小时，重复提交不会重复创建。
#[tauri::command]
pub fn new_command_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 启动时的一次性环境信息。
#[derive(Debug, serde::Serialize)]
pub struct StartupInfo {
    pub version: String,
    #[serde(rename = "dataDirectory")]
    pub data_directory: String,
    #[serde(rename = "cacheDirectory")]
    pub cache_directory: String,
    #[serde(rename = "stateDirectory")]
    pub state_directory: String,
    #[serde(rename = "agentLogFile")]
    pub agent_log_file: String,
    pub endpoint: String,
    #[serde(rename = "isDevelopment")]
    pub is_development: bool,
    /// 数据目录是否已建库。false 表示要走首次启动流程。
    pub initialized: bool,
    #[serde(rename = "bootstrapWarning")]
    pub bootstrap_warning: Option<String>,
    pub settings: DesktopSettings,
}

#[tauri::command]
pub async fn get_startup_info(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<StartupInfo, ApiError> {
    let settings = state.settings.lock().await.clone();
    Ok(StartupInfo {
        version: app.package_info().version.to_string(),
        data_directory: state.paths.data_directory.to_string_lossy().to_string(),
        cache_directory: state.paths.cache_directory.to_string_lossy().to_string(),
        state_directory: state.paths.state_directory.to_string_lossy().to_string(),
        agent_log_file: state.paths.agent_log_file.to_string_lossy().to_string(),
        endpoint: state.connection.endpoint().display_name().to_string(),
        is_development: state.paths.is_development,
        initialized: state.paths.data_directory_initialized(),
        bootstrap_warning: state.paths.bootstrap_warning.clone(),
        settings,
    })
}

/// 连接 Agent。`start` 为 false 时只接回已有 Agent，绝不启动新进程。
#[tauri::command]
pub async fn connect_agent(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    start: bool,
) -> Result<ConnectionSnapshot, ApiError> {
    state.suppress_reconnect.store(false, Ordering::Release);
    Ok(state.connect_and_bootstrap(&app, start).await)
}

/// 手动请求一次全量快照。
#[tauri::command]
pub async fn refresh_bootstrap(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), ApiError> {
    if !state.connection.is_connected().await {
        return Err(ApiError {
            code: "AGENT_NOT_CONNECTED".into(),
            message: "尚未连接 Agent".into(),
            retryable: true,
        });
    }
    state.push_bootstrap(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, Arc<AppState>>,
    next: DesktopSettings,
) -> Result<(), ApiError> {
    settings::save(&state.paths.settings_file, &next)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    *state.settings.lock().await = next;
    Ok(())
}

/// 「退出全部」：安全停止 Agent 后退出。
///
/// 先尝试接回已有 Agent，但**绝不为了退出而启动一个新的**。数据库存在只说明目录初始化
/// 过，不代表后台还有 Agent 在跑。
/// 退出进度。
///
/// Agent 的关闭是一个 16 步、整体上限 20 秒的流程（见 src/agent/shutdownSequence.js）。
/// 第 8 步要等 handler 与维护 Worker 收敛——Profile 扫描正在跑时那一步就会耗掉数秒。
/// 不上报进度的话「退出全部」看起来像没反应，用户会反复点击。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitProgress {
    pub stage: String,
    pub message: String,
    /// 已经进行的秒数，用于让界面显示「已等待 N 秒」而不是一个假的百分比。
    pub elapsed_seconds: u64,
    /// 是否已经可以安全强制结束。
    pub can_force: bool,
}

fn report_exit(
    app: &AppHandle,
    stage: &str,
    message: &str,
    started: std::time::Instant,
    can_force: bool,
) {
    let _ = app.emit(
        events::EXIT,
        ExitProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            elapsed_seconds: started.elapsed().as_secs(),
            can_force,
        },
    );
}

#[tauri::command]
pub async fn exit_all(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    force: Option<bool>,
) -> Result<(), ApiError> {
    // 幂等：用户在等待期间反复点「退出全部」不该叠出多条关闭流程。第一次调用已经把
    // Agent 推进了 draining，重复发 system.shutdown 只会让日志更难读。
    if state.exiting.swap(true, Ordering::AcqRel) && force != Some(true) {
        return Ok(());
    }
    state.suppress_reconnect.store(true, Ordering::Release);
    let started = std::time::Instant::now();

    report_exit(
        &app,
        "connecting",
        "正在确认后台 Agent 状态",
        started,
        false,
    );
    if !state.connection.is_connected().await {
        let snapshot = state
            .connection
            .ensure_connected(false, state.notifications(), || Ok(()))
            .await;
        if !snapshot.connected {
            // 没有 Agent 在跑，直接退。
            report_exit(
                &app,
                "done",
                "后台没有运行中的 Agent，正在退出",
                started,
                false,
            );
            state.launcher.reclaim_current();
            app.exit(0);
            return Ok(());
        }
    }

    // force=true 是用户在等待过程中主动选择的「不再等待」。它跳过有序关闭，直接关 job
    // 句柄让 KILL_ON_JOB_CLOSE 回收整棵进程树——数据库可能没有 checkpoint，但进程树
    // 一定干净，不会留下孤儿 Chrome。
    if force == Some(true) {
        report_exit(&app, "forcing", "正在强制结束后台进程树", started, false);
        state.connection.disconnect().await;
        state.launcher.reclaim_current();
        app.exit(0);
        return Ok(());
    }

    report_exit(
        &app,
        "draining",
        "正在请求 Agent 收尾：取消排队任务、关闭 Chrome 窗口",
        started,
        false,
    );
    let _ = state
        .connection
        .call_internal(
            "system.shutdown",
            serde_json::json!({ "reason": "user-exit-all", "force": true }),
            Some(uuid::Uuid::new_v4().to_string()),
        )
        .await;

    // 等 IPC 真的断开。超时也继续退出：不能因为第三方浏览器驱动迟迟不放句柄就把
    // 窗口锁成永远关不上。Agent 自身有有界清理和最终退出保障。
    //
    // 上限取 20 秒对齐 Agent 的 OVERALL_TIMEOUT_MS：比它短会在 Agent 仍在正常收尾时
    // 就放弃，比它长则是白等。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while state.connection.is_connected().await && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // 3 秒后才提供「强制退出」：更早给出会诱导用户在正常的 1-2 秒收尾期就跳过
        // SQLite checkpoint。
        report_exit(
            &app,
            "waiting",
            "正在等待 Agent 释放数据库与 Profile 句柄",
            started,
            started.elapsed() >= std::time::Duration::from_secs(3),
        );
    }

    report_exit(&app, "done", "资源已释放，正在退出", started, false);
    state.connection.disconnect().await;
    state.launcher.reclaim_current();
    app.exit(0);
    Ok(())
}

/// 隐藏到托盘。
#[tauri::command]
pub fn hide_to_tray(app: AppHandle) -> Result<(), ApiError> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .hide()
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 数据目录与旧项目导入
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
pub struct DataRootCheck {
    pub ok: bool,
    pub path: String,
    pub reason: Option<String>,
    /// 目标是否已经建库。已建库的目录不能作为导入目标。
    pub initialized: bool,
}

/// 校验一个候选数据目录。
#[tauri::command]
pub fn check_data_root(app: AppHandle, path: String) -> DataRootCheck {
    let candidate = PathBuf::from(&path);
    let installation = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    match crate::paths::validate_data_root(&candidate) {
        Err(error) => DataRootCheck {
            ok: false,
            path,
            reason: Some(error.to_string()),
            initialized: false,
        },
        Ok(full) => {
            if let Err(error) = crate::paths::assert_not_inside_installation(&full, &installation) {
                return DataRootCheck {
                    ok: false,
                    path: full.to_string_lossy().to_string(),
                    reason: Some(error.to_string()),
                    initialized: false,
                };
            }
            let initialized = full.join("keeper.db").exists();
            DataRootCheck {
                ok: true,
                path: full.to_string_lossy().to_string(),
                reason: None,
                initialized,
            }
        }
    }
}

/// 记下新数据目录，下次启动生效。
///
/// 换数据目录必须重启进程：`AppPaths` 在启动最早期解析，端点、单实例域和 Agent 环境
/// 都由它派生，运行期改会让这三者互相矛盾。
#[tauri::command]
pub async fn use_data_root(state: State<'_, Arc<AppState>>, path: String) -> Result<(), ApiError> {
    let full = crate::paths::validate_data_root(&PathBuf::from(&path))
        .map_err(|error| ApiError::validation(error.to_string()))?;
    let pointer = serde_json::json!({ "version": 1, "dataRoot": full.to_string_lossy() });

    let file = &state.paths.bootstrap_file;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| ApiError::internal(error.to_string()))?;
    }
    let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(&pointer).map_err(|error| ApiError::internal(error.to_string()))?,
    )
    .map_err(|error| ApiError::internal(error.to_string()))?;
    std::fs::rename(&temporary, file).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        ApiError::internal(error.to_string())
    })?;
    Ok(())
}

/// 只读预检一个旧项目目录。不修改旧数据。
#[tauri::command]
pub async fn inspect_legacy(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<serde_json::Value, ApiError> {
    let probe = crate::agent::resources::resolve_command(
        state.launcher.resource_root(),
        state.paths.is_development,
    )
    .and_then(|command| {
        crate::agent::resources::find_migration_probe(&command).map(|probe| (command, probe))
    });

    let Some((command, probe)) = probe else {
        return Err(ApiError {
            code: "MIGRATION_PROBE_UNAVAILABLE".into(),
            message: "找不到随 Agent 安装的迁移检查程序；请确认开发依赖或重新安装应用".into(),
            retryable: false,
        });
    };

    let output = tokio::process::Command::new(&command.program)
        .arg(&probe)
        .arg("--legacy-root")
        .arg(&path)
        .arg("--data-root")
        .arg(&state.paths.data_directory)
        .current_dir(probe.parent().unwrap_or(&state.paths.data_directory))
        .output()
        .await
        .map_err(|error| ApiError {
            code: "MIGRATION_PROBE_START_FAILED".into(),
            message: error.to_string(),
            retryable: false,
        })?;

    // 预检脚本可能先打印日志再输出 JSON，取最后一个以 { 开头的行。
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = stdout
        .lines()
        .rfind(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| ApiError {
            code: "MIGRATION_PROBE_INVALID_OUTPUT".into(),
            message: format!(
                "迁移检查程序没有返回有效结果（退出码 {}）",
                output.status.code().unwrap_or(-1)
            ),
            retryable: false,
        })?;
    serde_json::from_str(json).map_err(|error| ApiError {
        code: "MIGRATION_PROBE_INVALID_OUTPUT".into(),
        message: error.to_string(),
        retryable: false,
    })
}

/// 在当前数据目录导入旧项目。
///
/// 迁移发生在 Agent 建立 IPC **之前**：它靠「keeper.db 不存在」保证不覆盖任何现有数据。
/// 所以这条路径先让当前 Agent 完整释放句柄，再用 `--legacy-root` 重启。
#[tauri::command]
pub async fn import_legacy(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<ConnectionSnapshot, ApiError> {
    if state.connection.is_connected().await {
        return Err(ApiError {
            code: "RESOURCE_BUSY".into(),
            message: "Agent 正在运行；请先退出全部再导入，或改选一个尚未建库的新数据目录".into(),
            retryable: false,
        });
    }

    let legacy = PathBuf::from(&path);
    let endpoint = state.connection.endpoint().clone();
    let launch = state
        .launcher
        .start(&endpoint, Some(&legacy))
        .map_err(|error| ApiError::internal(error.to_string()))?;

    crate::state::spawn_migration_watch(app.clone(), launch.progress_file.clone());

    // 迁移期间 Agent 不暴露 IPC。轮询等它完成，同时监视进程是否已经退出。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let mut last = None;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        let progress = crate::agent::migration::read(&launch.progress_file, &mut last, false);
        if let Some(progress) = &progress {
            if progress.is_failed() {
                let reason = progress
                    .error
                    .as_ref()
                    .map(|error| format!("[{}] {}", error.code, error.message))
                    .unwrap_or_else(|| progress.message.clone());
                return Err(ApiError {
                    code: "MIGRATION_FAILED".into(),
                    message: format!(
                        "{reason}。旧目录未被修改。诊断日志：{}",
                        launch.log_file.display()
                    ),
                    retryable: false,
                });
            }
        }

        if !state.launcher.current_is_running() {
            let final_progress =
                crate::agent::migration::read(&launch.progress_file, &mut last, true);
            let reason = final_progress
                .and_then(|progress| progress.error.map(|error| error.message))
                .unwrap_or_else(|| "Agent 在建立 IPC 前退出".to_string());
            return Err(ApiError {
                code: "MIGRATION_FAILED".into(),
                message: format!(
                    "{reason}。旧目录未被修改。诊断日志：{}",
                    launch.log_file.display()
                ),
                retryable: false,
            });
        }

        let complete = progress
            .map(|progress| progress.is_complete())
            .unwrap_or(false);
        if !complete {
            continue;
        }
        let snapshot = state.connect_and_bootstrap(&app, false).await;
        if snapshot.connected {
            return Ok(snapshot);
        }
    }

    Err(ApiError {
        code: "MIGRATION_TIMEOUT".into(),
        message: format!(
            "迁移未在限定时间内完成，请查看日志：{}",
            launch.log_file.display()
        ),
        retryable: false,
    })
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: String,
    pub message: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub stage: Option<InstallStage>,
    pub percent: Option<u8>,
    pub can_cancel: bool,
}

impl UpdateStatus {
    fn simple(state: &str, message: impl Into<String>) -> Self {
        Self {
            state: state.into(),
            message: message.into(),
            version: None,
            notes: None,
            stage: None,
            percent: None,
            can_cancel: false,
        }
    }
}

/// 检查更新。
///
/// deb / rpm 上不检查：它们的 `install()` 会弹 pkexec / zenity 的 root 密码框，一个
/// 后台更新器这么做比让用户跑 `apt upgrade` 更糟。这两种包由发行版包管理器升级。
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateStatus, ApiError> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if !self_update_supported() {
            return Ok(UpdateStatus::simple(
                "unsupported",
                "该安装方式由系统包管理器升级（apt / dnf），应用内不检查更新",
            ));
        }

        use tauri_plugin_updater::UpdaterExt;
        let updater = app
            .updater()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        match updater.check().await {
            Ok(Some(update)) => Ok(UpdateStatus {
                state: "available".into(),
                message: format!("发现新版本 {}", update.version),
                version: Some(update.version.clone()),
                notes: update.body.clone(),
                stage: None,
                percent: None,
                can_cancel: true,
            }),
            Ok(None) => Ok(UpdateStatus::simple("current", "当前已是最新版本")),
            Err(error) => Ok(UpdateStatus::simple(
                "error",
                format!("更新检查失败：{error}"),
            )),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = &app;
        Ok(UpdateStatus::simple(
            "unsupported",
            "该平台不支持应用内更新",
        ))
    }
}

/// 当前安装方式是否支持应用内自更新。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn self_update_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        // AppImage 会设置 APPIMAGE；deb / rpm 装出来的进程没有它。
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// 安装更新：预检 → 下载 → 排空 → 关 Agent → 安装。
///
/// 下载放在预检**之后**：有阻塞项时不浪费一次完整下载（包体含私有 Node + Agent +
/// mihomo），且下载结果只在这一次流程内存活，不会因为等待安全空闲点而常驻内存几小时。
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), ApiError> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (&app, &state);
        return Err(ApiError::internal("该平台不支持应用内更新"));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_updater::UpdaterExt;

        let report = |stage: InstallStage, percent: Option<u8>| {
            let _ = app.emit(
                events::UPDATE,
                UpdateStatus {
                    state: "installing".into(),
                    message: stage.message().to_string(),
                    version: None,
                    notes: None,
                    stage: Some(stage),
                    percent,
                    can_cancel: stage.can_cancel(),
                },
            );
        };

        // 1) 预检。此时还没下载，被阻塞就直接停下。
        report(InstallStage::Preflight, None);
        if !state.connection.is_connected().await {
            let snapshot = state.connect_and_bootstrap(&app, true).await;
            if !snapshot.connected {
                return Err(ApiError::internal(snapshot.detail));
            }
        }
        let preflight = state
            .connection
            .call_internal(
                "system.prepareUpdate",
                serde_json::json!({ "commit": false, "reason": "desktop-update" }),
                Some(uuid::Uuid::new_v4().to_string()),
            )
            .await?;
        if preflight.get("ready").and_then(serde_json::Value::as_bool) != Some(true) {
            return Err(ApiError {
                code: "RESOURCE_BUSY".into(),
                message: format!("仍有阻塞项：{}", describe_blockers(&preflight)),
                retryable: true,
            });
        }

        // 2) 下载。
        report(InstallStage::Downloading, Some(0));
        let updater = app
            .updater()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let update = updater
            .check()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::internal("当前没有可安装的更新"))?;

        let total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let bytes = {
            let app = app.clone();
            let total = std::sync::Arc::clone(&total);
            let downloaded = std::sync::Arc::clone(&downloaded);
            update
                .download(
                    move |chunk, length| {
                        if let Some(length) = length {
                            total.store(length, Ordering::Relaxed);
                        }
                        let done =
                            downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                        let length = total.load(Ordering::Relaxed);
                        let percent = (done * 100)
                            .checked_div(length)
                            .map(|value| value.min(100) as u8);
                        let _ = app.emit(
                            events::UPDATE,
                            UpdateStatus {
                                state: "installing".into(),
                                message: InstallStage::Downloading.message().to_string(),
                                version: None,
                                notes: None,
                                stage: Some(InstallStage::Downloading),
                                percent,
                                can_cancel: true,
                            },
                        );
                    },
                    || {},
                )
                .await
                .map_err(|error| ApiError::internal(format!("下载更新失败：{error}")))?
        };

        // 3) 排空。从这里起不可取消：Agent 进入拒绝写入状态，必须走完。
        report(InstallStage::Draining, None);
        let drained = state
            .connection
            .call_internal(
                "system.prepareUpdate",
                serde_json::json!({ "commit": true, "reason": "desktop-update" }),
                Some(uuid::Uuid::new_v4().to_string()),
            )
            .await?;
        let ready = drained.get("ready").and_then(serde_json::Value::as_bool) == Some(true);
        let committed = drained
            .get("committed")
            .and_then(serde_json::Value::as_bool)
            == Some(true);
        if !ready || !committed {
            return Err(ApiError {
                code: "RESOURCE_BUSY".into(),
                message: format!(
                    "Agent 未能进入更新排空状态：{}",
                    describe_blockers(&drained)
                ),
                retryable: true,
            });
        }

        // 4) 关 Agent，等它释放数据库和 Profile 句柄。
        report(InstallStage::StoppingAgent, None);
        state.suppress_reconnect.store(true, Ordering::Release);
        let _ = state
            .connection
            .call_internal(
                "system.shutdown",
                serde_json::json!({ "reason": "desktop-update", "force": false }),
                Some(uuid::Uuid::new_v4().to_string()),
            )
            .await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while state.launcher.current_is_running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        state.connection.disconnect().await;
        state.launcher.reclaim_current();

        // 5) 安装。Windows 在这里内部退出并由 NSIS 重启；macOS/Linux 返回后要自己重启。
        report(InstallStage::Installing, None);
        update
            .install(bytes)
            .map_err(|error| ApiError::internal(format!("安装更新失败：{error}")))?;
        if crate::update::needs_explicit_relaunch() {
            app.restart();
        }
        Ok(())
    }
}

fn describe_blockers(result: &serde_json::Value) -> String {
    let Some(blockers) = result.get("blockers").and_then(serde_json::Value::as_array) else {
        return "未报告具体原因".to_string();
    };
    if blockers.is_empty() {
        return "未报告具体原因".to_string();
    }
    blockers
        .iter()
        .map(|blocker| {
            blocker
                .get("resourceId")
                .and_then(serde_json::Value::as_str)
                .or_else(|| blocker.get("kind").and_then(serde_json::Value::as_str))
                .unwrap_or("未知")
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("、")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blockers_are_described_by_resource_then_kind() {
        let result = serde_json::json!({
            "blockers": [
                { "kind": "browser", "resourceId": "account-7" },
                { "kind": "operation" }
            ]
        });
        assert_eq!(describe_blockers(&result), "account-7、operation");
    }

    #[test]
    fn an_empty_or_missing_blocker_list_still_yields_a_message() {
        // 空列表配 ready=false 是 Agent 的合法响应；界面不能显示一个空的「仍有阻塞项：」。
        assert_eq!(
            describe_blockers(&serde_json::json!({ "blockers": [] })),
            "未报告具体原因"
        );
        assert_eq!(describe_blockers(&serde_json::json!({})), "未报告具体原因");
    }

    #[test]
    fn an_agent_error_keeps_its_stable_code() {
        let error: ApiError =
            crate::ipc::client::CallError::Agent(crate::ipc::protocol::AgentError {
                code: "CHROME_NOT_FOUND".into(),
                message: "未安装 Chrome".into(),
                retryable: false,
                details: serde_json::Value::Null,
            })
            .into();
        assert_eq!(error.code, "CHROME_NOT_FOUND");
        assert!(!error.retryable);
    }

    #[test]
    fn a_timeout_is_marked_retryable() {
        let error: ApiError = crate::ipc::client::CallError::Timeout("accounts.list".into()).into();
        assert_eq!(error.code, "AGENT_TIMEOUT");
        assert!(error.retryable);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_self_update_requires_an_appimage() {
        // deb / rpm 的 install() 会弹 root 密码框，所以它们不参与应用内更新。
        std::env::remove_var("APPIMAGE");
        assert!(!self_update_supported());
        std::env::set_var("APPIMAGE", "/tmp/Keeper.AppImage");
        assert!(self_update_supported());
        std::env::remove_var("APPIMAGE");
    }

    #[test]
    #[cfg(windows)]
    fn windows_always_supports_self_update() {
        assert!(self_update_supported());
    }
}
