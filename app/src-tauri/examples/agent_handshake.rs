//! S0-3 验收 spike：用 Rust 客户端连真实的 Node Agent 并跑通三个调用。
//!
//! 这不是单元测试：它要启动一个真的 Agent 进程、建立真的命名管道/UDS 连接，并在一个
//! 独立的数据目录里建库。运行：
//!
//! ```powershell
//! cargo run --example agent_handshake
//! ```
//!
//! 验收内容：
//! 1. Agent 在创建时就被纳入 Job Object（S0-2 的成果在真 Agent 上复验）。
//! 2. `system.hello` 协商成功，协议 1.3，数据目录一致。
//! 3. `system.bootstrap` 与 `accounts.list` 返回契约内的结构。
//! 4. 「端点尚未创建」在 Rust 侧是可判别的 NotReady，不是异常刷屏。
//! 5. 退出时整棵进程树被回收，零孤儿。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use keeper_app_lib::agent::launcher::Launcher;
use keeper_app_lib::ipc::connection::Connection;
use keeper_app_lib::ipc::{credential, endpoint, transport};
use keeper_app_lib::paths::AppPaths;

fn isolated_paths(root: &Path) -> AppPaths {
    AppPaths {
        configuration_directory: root.join("config"),
        settings_file: root.join("config/desktop.json"),
        bootstrap_file: root.join("config/bootstrap.json"),
        ipc_key_file: root.join("config/ipc.key"),
        data_directory: root.join("data"),
        database_file: root.join("data/keeper.db"),
        cache_directory: root.join("cache"),
        state_directory: root.join("state"),
        agent_log_file: root.join("state/agent.log"),
        migration_progress_file: root.join("state/migration-progress.json"),
        is_development: true,
        bootstrap_warning: None,
    }
}

fn repository_root() -> PathBuf {
    // examples/ 在 app/src-tauri 之下，仓库根再往上两级。
    //
    // 刻意不 canonicalize：它在 Windows 上返回 \?\ 前缀，而 Node 的 ESM 加载器不
    // 接受那种路径。生产代码里由 resources::strip_verbatim_prefix 兜住，这里保持
    // 朴素形式，让 spike 走的是与生产一致的路径形状。
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

#[tokio::main]
async fn main() {
    println!("=== S0-3 Agent 握手 spike ===");

    let root = std::env::var("KEEPER_SPIKE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::temp_dir().join(format!("keeper-s03-{}", uuid::Uuid::new_v4()))
        });
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    std::fs::create_dir_all(root.join("state")).unwrap();
    let paths = isolated_paths(&root);
    println!("数据目录: {}", paths.data_directory.display());

    let endpoint = endpoint::resolve_default(&paths.data_directory).expect("解析端点");
    println!("端点: {}", endpoint.display_name());

    // 验收 4：连一个还不存在的端点必须是可判别的 NotReady。
    match transport::connect(&endpoint, std::time::Duration::from_millis(200)).await {
        Err(transport::TransportError::NotReady(_)) => {
            println!("✓ 未创建的端点报 NotReady（不是异常刷屏）");
        }
        other => {
            println!("✗ 期望 NotReady，实际 {other:?}");
            std::process::exit(1);
        }
    }

    let credential = credential::load_or_create(&paths.ipc_key_file).expect("凭据");
    // 开发模式下从仓库根找 src/agent/launcher.js。
    let launcher = Arc::new(Launcher::new(
        paths.clone(),
        repository_root(),
        credential.clone(),
    ));
    let connection = Arc::new(Connection::new(
        endpoint.clone(),
        &paths.data_directory,
        credential,
        "0.2.0".into(),
    ));

    let (notifications, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(notification) = receiver.recv().await {
            if let keeper_app_lib::ipc::client::Notification::Event(event) = notification {
                println!("  [event] {} seq={:?}", event.name, event.seq);
            }
        }
    });

    println!("\n正在启动 Agent（首次运行会建库）…");
    let snapshot = {
        let launcher = Arc::clone(&launcher);
        let endpoint = endpoint.clone();
        connection
            .ensure_connected(true, notifications, move || {
                launcher
                    .start(&endpoint, None)
                    .map(|outcome| {
                        println!(
                            "  Agent PID {} 世代 {}",
                            outcome.process_id, outcome.generation_id
                        )
                    })
                    .map_err(|error| error.to_string())
            })
            .await
    };

    if !snapshot.connected {
        println!(
            "✗ 未能连接 Agent：{} — {}",
            snapshot.status, snapshot.detail
        );
        let log = std::fs::read_to_string(&paths.agent_log_file).unwrap_or_default();
        if !log.is_empty() {
            println!("--- agent.log ---\n{log}");
        }
        cleanup(&launcher, &root);
        std::process::exit(1);
    }

    println!("✓ 已连接：{}", snapshot.detail);
    println!(
        "  Agent 版本 {} · 实例 {}",
        snapshot.agent_version.as_deref().unwrap_or("?"),
        snapshot.instance_id.as_deref().unwrap_or("?")
    );

    // 验收 3：bootstrap 与 accounts.list。
    let mut failures = Vec::new();

    match connection
        .call_internal("system.bootstrap", serde_json::json!({}), None)
        .await
    {
        Ok(bootstrap) => {
            let keys: Vec<&str> = bootstrap
                .as_object()
                .map(|map| map.keys().map(String::as_str).collect())
                .unwrap_or_default();
            println!("✓ system.bootstrap 返回 {} 个字段", keys.len());
            for required in ["accounts", "groups", "proxies", "conversations", "settings"] {
                if !keys.contains(&required) {
                    failures.push(format!("bootstrap 缺少字段 {required}"));
                }
            }
        }
        Err(error) => failures.push(format!("system.bootstrap 失败：{error}")),
    }

    match connection
        .call_from_ui("accounts.list", serde_json::json!({}), None)
        .await
    {
        Ok(accounts) => {
            let count = accounts.as_array().map(Vec::len).unwrap_or(0);
            println!("✓ accounts.list 返回 {count} 个账号（新库应为 0）");
        }
        Err(error) => failures.push(format!("accounts.list 失败：{error}")),
    }

    // 白名单边界：前端不能调 system.*。
    match connection
        .call_from_ui("system.shutdown", serde_json::json!({}), None)
        .await
    {
        Err(keeper_app_lib::ipc::client::CallError::Agent(error))
            if error.code == "VALIDATION_FAILED" =>
        {
            println!("✓ system.shutdown 被 UI 白名单拒绝");
        }
        other => failures.push(format!("system.shutdown 竟然可从 UI 调用：{other:?}")),
    }

    // 验收 5：退出时整棵树被回收。
    println!("\n正在停止 Agent…");
    let _ = connection
        .call_internal(
            "system.shutdown",
            serde_json::json!({ "reason": "spike", "force": true }),
            Some(uuid::Uuid::new_v4().to_string()),
        )
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    launcher.reclaim_current();
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    if launcher.current_is_running() {
        failures.push("回收后 Agent 进程仍在运行".into());
    } else {
        println!("✓ Agent 进程已回收");
    }

    println!("\n=== 结论 ===");
    if failures.is_empty() {
        println!("✓ S0-3 通过。");
        cleanup(&launcher, &root);
    } else {
        for failure in &failures {
            println!("✗ {failure}");
        }
        let log = std::fs::read_to_string(&paths.agent_log_file).unwrap_or_default();
        if !log.is_empty() {
            println!("--- agent.log (尾部) ---");
            for line in log.lines().rev().take(30).collect::<Vec<_>>().iter().rev() {
                println!("{line}");
            }
        }
        cleanup(&launcher, &root);
        std::process::exit(1);
    }
}

fn cleanup(launcher: &Launcher, root: &Path) {
    launcher.reclaim_current();
    std::thread::sleep(std::time::Duration::from_millis(500));
    if std::env::var("KEEPER_SPIKE_KEEP").is_err() {
        let _ = std::fs::remove_dir_all(root);
    } else {
        println!("(保留数据目录用于诊断：{})", root.display());
    }
}
