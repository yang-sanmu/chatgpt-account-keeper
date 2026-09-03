//! 更新期间持有 Agent 的数据目录锁，不打开数据库。

use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;

#[derive(Debug)]
pub struct UpdateLock {
    #[cfg(windows)]
    _pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    #[cfg(unix)]
    _listener: std::os::unix::net::UnixListener,
    #[cfg(unix)]
    socket_path: std::path::PathBuf,
}

impl UpdateLock {
    pub fn acquire(data_root: &Path) -> io::Result<Self> {
        let endpoint = lock_endpoint(data_root)?;
        // 与 Agent 一样，损坏/残缺的诊断文件交给内核锁判断；可识别的 PID 旧版仍须阻塞。
        let metadata: Option<serde_json::Value> =
            match std::fs::read_to_string(data_root.join("agent.lock")) {
                Ok(text) => serde_json::from_str(&text).ok(),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::InvalidData
                    ) =>
                {
                    None
                }
                Err(error) => return Err(error),
            };
        if let Some(metadata) = metadata {
            let pid = metadata.get("pid").and_then(|pid| match pid {
                serde_json::Value::Number(number) => number.as_f64(),
                serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
                serde_json::Value::Bool(true) => Some(1.0),
                _ => None,
            });
            let legacy = metadata
                .get("lockId")
                .is_none_or(serde_json::Value::is_null)
                && pid.is_some_and(|pid| pid.is_finite() && pid > 0.0 && pid.fract() == 0.0);
            let different_endpoint = metadata
                .get("lockEndpoint")
                .and_then(serde_json::Value::as_str)
                .filter(|address| !address.is_empty())
                .is_some_and(|address| address != endpoint);
            if legacy || different_endpoint {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "无法确认旧 Agent 已释放数据目录",
                ));
            }
        }

        #[cfg(windows)]
        {
            let pipe = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(&endpoint)?;
            Ok(Self { _pipe: pipe })
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, PermissionsExt};
            use std::os::unix::net::{UnixListener, UnixStream};
            let socket_path = std::path::PathBuf::from(endpoint);
            let listener = match UnixListener::bind(&socket_path) {
                Ok(listener) => listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                    match UnixStream::connect(&socket_path) {
                        Ok(_) => return Err(error),
                        Err(probe)
                            if matches!(
                                probe.kind(),
                                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                            ) => {}
                        Err(probe) => return Err(probe),
                    }
                    match std::fs::symlink_metadata(&socket_path) {
                        Ok(metadata) if metadata.file_type().is_socket() => {
                            std::fs::remove_file(&socket_path)?
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        _ => return Err(error),
                    }
                    UnixListener::bind(&socket_path)?
                }
                Err(error) => return Err(error),
            };
            let guard = Self {
                _listener: listener,
                socket_path,
            };
            std::fs::set_permissions(&guard.socket_path, std::fs::Permissions::from_mode(0o600))?;
            Ok(guard)
        }
    }
}

#[cfg(unix)]
impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

// 必须与 src/agent/instanceLock.js 相同：共用内核锁才能阻止下载期间另一个 Agent 启动。
fn lock_endpoint(data_root: &Path) -> io::Result<String> {
    if !data_root.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "数据目录必须是绝对路径",
        ));
    }
    #[cfg(windows)]
    let identity = {
        use windows::core::PWSTR;
        use windows::Win32::System::WindowsProgramming::GetUserNameW;
        // Node 的 os.userInfo() 使用系统登录名，USERNAME 环境变量可被覆盖，不能参与锁身份。
        let mut buffer = [0u16; 257]; // UNLEN + 1，包含末尾 NUL。
        let mut length = buffer.len() as u32;
        unsafe { GetUserNameW(Some(PWSTR(buffer.as_mut_ptr())), &mut length) }
            .map_err(|error| io::Error::other(error.to_string()))?;
        let user = String::from_utf16(&buffer[..length.saturating_sub(1) as usize])
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        format!(
            "{}\\{user}",
            std::env::var("USERDOMAIN").unwrap_or_default()
        )
    };
    #[cfg(unix)]
    let identity = unsafe { libc::getuid() }.to_string();
    let lock_file = crate::ipc::endpoint::canonical_data_root(&data_root.join("agent.lock"));
    let digest = Sha256::digest(format!("{identity}\0{lock_file}").as_bytes());
    let suffix = hex::encode(&digest[..12]);
    #[cfg(windows)]
    {
        Ok(format!(r"\\.\pipe\gptaccountkeeper-data-lock-{suffix}"))
    }
    #[cfg(unix)]
    {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/tmp".into()
                } else {
                    std::env::temp_dir()
                }
            });
        let endpoint = runtime.join(format!("kpr-data-lock-{suffix}.sock"));
        let text = endpoint.to_string_lossy().replace('\\', "/");
        if text.as_bytes().len() >= crate::ipc::endpoint::unix_socket_path_limit() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "数据目录锁的 socket 路径过长",
            ));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn temporary_root() -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("keeper-update-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn node_lock(root: &Path, hold: bool) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("node");
        command
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args(["--input-type=module", "-e", r#"
                import { acquireInstanceLock } from './src/agent/instanceLock.js';
                try {
                    const lock = await acquireInstanceLock(process.argv[1]);
                    console.log('locked');
                    if (process.argv[2] === 'hold') {
                        process.stdin.resume();
                        process.stdin.once('data', async () => { await lock.release(); process.exit(0); });
                    } else { await lock.release(); }
                } catch (error) { console.error(error.code); process.exit(23); }
            "#, "--"])
            .arg(root.join("agent.lock"))
            .arg(if hold { "hold" } else { "probe" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }

    #[tokio::test]
    async fn update_and_the_real_agent_cannot_hold_the_same_data_directory() {
        let root = temporary_root();
        let guard = UpdateLock::acquire(&root).expect("停止的 Agent 不应阻止更新取得数据目录锁");
        let blocked =
            tokio::time::timeout(Duration::from_secs(5), node_lock(&root, false).output())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(blocked.status.code(), Some(23), "更新期间不能启动 Agent");
        drop(guard);

        let mut agent = node_lock(&root, true).spawn().unwrap();
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new(agent.stdout.take().unwrap()).read_line(&mut line),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(line.trim(), "locked");
        assert!(
            UpdateLock::acquire(&root).is_err(),
            "活着但未暴露 IPC 的 Agent 也必须阻止更新"
        );
        agent
            .stdin
            .take()
            .unwrap()
            .write_all(b"release\n")
            .await
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), agent.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
        drop(UpdateLock::acquire(&root).expect("Agent 退出后应允许更新"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stale_modern_lock_metadata_does_not_prevent_recovery_updates() {
        let root = temporary_root();
        std::fs::write(root.join("agent.lock"), r#"{"pid":123,"lockId":"stale"}"#).unwrap();
        assert!(
            UpdateLock::acquire(&root).is_ok(),
            "进程退出后内核锁已释放，遗留元数据不应卡住修复更新"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn windows_update_lock_ignores_overridden_or_missing_username_environment() {
        use std::os::windows::process::CommandExt;
        for username in [Some("keeper-test-incorrect-user"), None] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args([
                "--exact",
                "agent::update_lock::tests::update_and_the_real_agent_cannot_hold_the_same_data_directory",
                "--nocapture",
            ]).creation_flags(0x08000000);
            if let Some(username) = username {
                command.env("USERNAME", username);
            } else {
                command.env_remove("USERNAME");
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "环境变量不得改变 Agent 的锁身份：{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[tokio::test]
    async fn corrupted_diagnostic_metadata_does_not_block_a_free_kernel_lock() {
        let root = temporary_root();
        for text in [
            "",
            "{\"pid\":",
            "not-json",
            "{}",
            r#"{"pid":0}"#,
            r#"{"pid":-1}"#,
            r#"{"pid":1.5}"#,
            r#"{"pid":"bad"}"#,
        ] {
            std::fs::write(root.join("agent.lock"), text).unwrap();
            drop(UpdateLock::acquire(&root).expect("损坏的诊断文件不能替代内核锁判断占用"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unverifiable_legacy_lock_metadata_is_not_treated_as_a_stopped_agent() {
        let root = temporary_root();
        std::fs::write(root.join("agent.lock"), r#"{"pid":123}"#).unwrap();
        assert!(UpdateLock::acquire(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
