pub mod agent;
pub mod commands;
pub mod instance;
pub mod ipc;
pub mod paths;
pub mod settings;
pub mod state;
pub mod tray;
pub mod update;

use std::sync::Arc;

use tauri::Manager;

/// 启动应用。
///
/// 顺序是有讲究的：单实例守卫必须在任何窗口或插件之前，且必须按数据目录分域，所以
/// `AppPaths` 是最先解析的东西。
pub fn run() {
    let paths = match paths::AppPaths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("无法确定应用目录：{error}");
            std::process::exit(2);
        }
    };

    // 同一数据目录的第二个实例只把已有窗口带到前台，然后退出。
    // 不同数据目录可以共存（开发模式与安装模式）。
    let Some(guard) = instance::try_acquire(&paths.data_directory) else {
        instance::signal_existing(&paths.data_directory);
        return;
    };

    let endpoint = match ipc::endpoint::resolve(&paths.data_directory) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("无法确定 IPC 端点：{error}");
            std::process::exit(2);
        }
    };
    let credential = match ipc::credential::load_or_create(&paths.ipc_key_file) {
        Ok(credential) => credential,
        Err(error) => {
            eprintln!("无法准备 IPC 凭据：{error}");
            std::process::exit(2);
        }
    };

    let desktop_settings = settings::load(&paths.settings_file);
    let (notifications, receiver) = tokio::sync::mpsc::unbounded_channel();

    // `--hidden` 由开机自启使用：登录后隐藏到托盘并恢复调度，不弹窗口。
    let start_hidden = std::env::args().any(|argument| argument == "--hidden");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_window_state::Builder::default().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::agent_call,
            commands::new_command_id,
            commands::get_startup_info,
            commands::connect_agent,
            commands::refresh_bootstrap,
            commands::save_settings,
            commands::exit_all,
            commands::hide_to_tray,
            commands::check_data_root,
            commands::use_data_root,
            commands::inspect_legacy,
            commands::import_legacy,
            commands::check_update,
            commands::install_update,
            set_scheduler_tray_state,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let resource_root = handle.path().resource_dir().unwrap_or_else(|_| {
                std::env::current_exe()
                    .ok()
                    .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
                    .unwrap_or_default()
            });

            let connection = Arc::new(ipc::connection::Connection::new(
                endpoint.clone(),
                &paths.data_directory,
                credential.clone(),
                handle.package_info().version.to_string(),
            ));
            let launcher = Arc::new(agent::launcher::Launcher::new(
                paths.clone(),
                resource_root,
                credential.clone(),
            ));
            let state = Arc::new(state::AppState::new(
                paths.clone(),
                connection,
                launcher,
                desktop_settings.clone(),
                notifications.clone(),
            ));
            app.manage(Arc::clone(&state));

            let tray_handles = tray::build(&handle)?;
            app.manage(Arc::clone(&tray_handles));

            state::spawn_event_pump(handle.clone(), Arc::clone(&state), receiver);

            // 同数据目录的第二实例激活信号。守卫的所有权移进这个线程：它要活到进程结束。
            {
                let handle = handle.clone();
                std::thread::spawn(move || loop {
                    if !guard.wait_for_activation() {
                        // 等待失败说明信号通道没了，重试没有意义。
                        return;
                    }
                    let target = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        tray::show_main_window(&target);
                    });
                });
            }

            // 已经建库过就直接连；否则留给前端走首次启动流程。
            if state.paths.data_directory_initialized() {
                let handle = handle.clone();
                let state = Arc::clone(&state);
                tauri::async_runtime::spawn(async move {
                    state.connect_and_bootstrap(&handle, true).await;
                });
            }

            if !start_hidden {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口的默认行为是隐藏到托盘：后台调度必须在窗口关掉之后继续跑。
            // 「每次询问 / 退出全部」的分支由前端处理，它会先调 hide_to_tray 或 exit_all。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = tauri::Emitter::emit(window, "keeper://close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

/// 前端在收到 `scheduler.changed` 后回调，让托盘菜单与真实状态一致。
#[tauri::command]
fn set_scheduler_tray_state(
    app: tauri::AppHandle,
    handles: tauri::State<'_, Arc<tray::TrayHandles>>,
    running: bool,
) -> Result<(), String> {
    tray::apply_scheduler_state(&app, &handles, running).map_err(|error| error.to_string())
}
