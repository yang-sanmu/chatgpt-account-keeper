//! 托盘图标与菜单。
//!
//! 菜单项跟随**真实**调度状态：不能出现「调度已在运行还提示『启动调度』可点」的情况。
//! 状态由前端在收到 `scheduler.changed` 后回调过来，因为调度状态的权威来源是 Agent 的
//! 事件流，不是我们本地的猜测。

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub struct TrayHandles {
    pub start_scheduler: MenuItem<tauri::Wry>,
    pub stop_scheduler: MenuItem<tauri::Wry>,
}

/// 托盘菜单项发给前端的动作。前端持有业务逻辑，托盘只是另一个入口。
pub const TRAY_ACTION_EVENT: &str = "keeper://tray-action";

pub fn build(app: &AppHandle) -> tauri::Result<Arc<TrayHandles>> {
    let show = MenuItem::with_id(app, "show", "打开管理界面", true, None::<&str>)?;
    let start_scheduler =
        MenuItem::with_id(app, "scheduler-start", "启动调度", true, None::<&str>)?;
    let stop_scheduler = MenuItem::with_id(app, "scheduler-stop", "停止调度", false, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let exit_all = MenuItem::with_id(app, "exit-all", "退出全部", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &start_scheduler,
            &stop_scheduler,
            &PredefinedMenuItem::separator(app)?,
            &check_update,
            &PredefinedMenuItem::separator(app)?,
            &exit_all,
        ],
    )?;

    let handles = Arc::new(TrayHandles {
        start_scheduler,
        stop_scheduler,
    });

    TrayIconBuilder::with_id("keeper-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("托盘图标缺失".into()))?,
        )
        .tooltip("ChatGPT Account Keeper · 调度已停止")
        .menu(&menu)
        // 左键直接激活窗口，不弹菜单。菜单走右键。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "show" => show_main_window(app),
                // 业务动作交给前端：它持有会话、错误提示和忙碌状态。
                // 在 Rust 里另写一遍会得到两套不一致的行为。
                other => {
                    let _ = tauri::Emitter::emit(app, TRAY_ACTION_EVENT, other);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Linux 上不会触发这个事件（托盘只有右键菜单），所以「打开管理界面」
            // 必须同时存在于菜单里，不能只靠左键。
            if let TrayIconEvent::Click { .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(handles)
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 让菜单项与真实调度状态一致。
pub fn apply_scheduler_state(
    app: &AppHandle,
    handles: &TrayHandles,
    running: bool,
) -> tauri::Result<()> {
    handles.start_scheduler.set_enabled(!running)?;
    handles.stop_scheduler.set_enabled(running)?;
    if let Some(tray) = app.tray_by_id("keeper-tray") {
        tray.set_tooltip(Some(if running {
            "ChatGPT Account Keeper · 调度运行中"
        } else {
            "ChatGPT Account Keeper · 调度已停止"
        }))?;
    }
    Ok(())
}
