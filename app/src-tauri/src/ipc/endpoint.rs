//! IPC 端点解析。
//!
//! 端点按「用户身份 + 开发/生产通道 + 数据目录」分域。数据目录分域是关键：不同数据
//! 目录可以同时各跑一个 Agent，而同一目录只能有一个（端点本身就是内核持有的锁）。

use std::path::Path;

use sha2::{Digest, Sha256};

const ENDPOINT_ENVIRONMENT_VARIABLE: &str = "GPTACCOUNTKEEPER_AGENT_ENDPOINT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    NamedPipe,
    UnixSocket,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub transport: Transport,
    pub address: String,
}

impl Endpoint {
    pub fn display_name(&self) -> &str {
        &self.address
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    #[error("IPC socket 路径超出系统上限（{length} >= {limit} 字节）：{path}。请把数据目录换到更短的路径，或设置 XDG_RUNTIME_DIR。")]
    UnixPathTooLong {
        path: String,
        length: usize,
        limit: usize,
    },
}

/// 规范化数据根，用于端点分域、单实例分域和 hello 的一致性校验。
///
/// Windows 上路径大小写不敏感，必须统一大写后再比较，否则同一个目录的两种写法会被
/// 当成两个数据根，各起一个 Agent 对着同一个 SQLite 写。
pub fn canonical_data_root(data_root: &Path) -> String {
    // 这里不能用 canonicalize：数据目录在首次运行时还不存在，而端点必须在建目录
    // 之前就能算出来。绝对化 + 去尾分隔符即可，路径的合法性由 paths::validate 管。
    let absolute = if data_root.is_absolute() {
        data_root.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(data_root)
    };
    let text = absolute.to_string_lossy();
    let trimmed = text
        .trim_end_matches(std::path::MAIN_SEPARATOR)
        .trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_uppercase()
    } else {
        trimmed.to_string()
    }
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..8])
}

/// 复用 paths 的判定，不要在这里再写一份。
///
/// 两份实现一旦不一致，就会出现「用开发数据目录 + 生产 IPC 通道」这种组合：调试版连上
/// 安装版仍在后台运行的 Agent，而那个 Agent 操作的是另一个数据目录。hello 里的数据根
/// 一致性校验会拒掉它，但表现出来只是一句连接失败，指不到真正原因。
fn is_development() -> bool {
    crate::paths::is_development()
}

/// `sockaddr_un.sun_path` 的硬上限：Darwin 104 字节，Linux 108（含结尾 NUL）。
pub fn unix_socket_path_limit() -> usize {
    if cfg!(target_os = "macos") {
        104
    } else {
        108
    }
}

#[cfg(unix)]
/// macOS 的临时目录是 `/var/folders/xx/<32 字符哈希>/T/`，约 51 字节，拼上端点名后
/// 开发模式已经越界。`/tmp` 短且稳定，文件名里已带 uid 和数据根哈希，不会互相撞。
fn default_unix_runtime_directory() -> String {
    if cfg!(target_os = "macos") {
        "/tmp".to_string()
    } else {
        std::env::temp_dir().to_string_lossy().to_string()
    }
}

#[cfg(unix)]
/// 超限时 bind/connect 报的是 EINVAL 或静默截断，不会说「路径太长」，所以自己先给
/// 一个能看懂的错误。按字节算，非 ASCII 路径会占多个字节。
fn ensure_unix_path_fits(path: String) -> Result<String, EndpointError> {
    let limit = unix_socket_path_limit();
    let length = path.as_bytes().len();
    if length >= limit {
        return Err(EndpointError::UnixPathTooLong {
            path,
            length,
            limit,
        });
    }
    Ok(path)
}

/// 解析端点。环境变量优先，用于诊断和测试注入。
pub fn resolve(data_root: &Path) -> Result<Endpoint, EndpointError> {
    if let Ok(configured) = std::env::var(ENDPOINT_ENVIRONMENT_VARIABLE) {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return Ok(parse(trimmed));
        }
    }
    resolve_default(data_root)
}

pub fn resolve_default(data_root: &Path) -> Result<Endpoint, EndpointError> {
    let scope = short_hash(&canonical_data_root(data_root));
    let channel = if is_development() { "dev-v1" } else { "v1" };

    #[cfg(windows)]
    {
        // 每用户分域：命名管道的名字空间是机器级的，多用户登录时不能互相看见。
        let domain = std::env::var("USERDOMAIN").unwrap_or_default();
        let user = std::env::var("USERNAME").unwrap_or_default();
        let identity = short_hash(&format!("{domain}\\{user}"));
        Ok(Endpoint {
            transport: Transport::NamedPipe,
            address: format!(r"\\.\pipe\gptaccountkeeper-agent-{channel}-{identity}-{scope}"),
        })
    }

    #[cfg(unix)]
    {
        let runtime_directory = std::env::var("XDG_RUNTIME_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_unix_runtime_directory);
        let uid = unsafe { libc::getuid() };
        let path = format!("{runtime_directory}/kpr-agent-{channel}-{uid}-{scope}.sock");
        Ok(Endpoint {
            transport: Transport::UnixSocket,
            address: ensure_unix_path_fits(normalize_separators(path))?,
        })
    }
}

#[cfg(unix)]
fn normalize_separators(path: String) -> String {
    // temp_dir 在某些环境下带尾分隔符，拼出来会是 //。
    path.replace("//", "/")
}

fn parse(value: &str) -> Endpoint {
    if value.starts_with(r"\\.\pipe\") {
        return Endpoint {
            transport: Transport::NamedPipe,
            address: value.to_string(),
        };
    }
    if cfg!(windows) && !Path::new(value).is_absolute() {
        return Endpoint {
            transport: Transport::NamedPipe,
            address: format!(r"\\.\pipe\{value}"),
        };
    }
    Endpoint {
        transport: Transport::UnixSocket,
        address: value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn different_data_roots_get_different_endpoints() {
        let one = resolve_default(&PathBuf::from(if cfg!(windows) {
            r"C:\data\keeper-a"
        } else {
            "/data/keeper-a"
        }))
        .unwrap();
        let two = resolve_default(&PathBuf::from(if cfg!(windows) {
            r"C:\data\keeper-b"
        } else {
            "/data/keeper-b"
        }))
        .unwrap();
        assert_ne!(one.address, two.address);
    }

    #[test]
    fn the_same_data_root_gets_a_stable_endpoint() {
        let root = PathBuf::from(if cfg!(windows) {
            r"C:\data\keeper"
        } else {
            "/data/keeper"
        });
        assert_eq!(
            resolve_default(&root).unwrap().address,
            resolve_default(&root).unwrap().address
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_data_root_comparison_ignores_case_and_trailing_separator() {
        assert_eq!(
            canonical_data_root(Path::new(r"C:\Data\Keeper\")),
            canonical_data_root(Path::new(r"c:\data\keeper"))
        );
    }

    #[test]
    #[cfg(unix)]
    fn unix_data_root_comparison_is_case_sensitive() {
        assert_ne!(
            canonical_data_root(Path::new("/data/Keeper")),
            canonical_data_root(Path::new("/data/keeper"))
        );
    }

    #[test]
    #[cfg(unix)]
    fn default_unix_endpoint_stays_inside_the_sun_path_limit() {
        // 这条在 C# 侧是回归测试：macOS 的 /var/folders/... 临时目录加上端点名会越界，
        // 而 bind 只会给 EINVAL。
        let endpoint = resolve_default(Path::new("/data/keeper")).unwrap();
        assert!(
            endpoint.address.as_bytes().len() < unix_socket_path_limit(),
            "{} 长度 {}",
            endpoint.address,
            endpoint.address.as_bytes().len()
        );
    }

    #[test]
    #[cfg(unix)]
    fn an_over_long_unix_path_reports_the_real_reason() {
        let long = format!("/{}/keeper.sock", "x".repeat(200));
        let error = ensure_unix_path_fits(long).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("超出系统上限"), "{message}");
    }

    #[test]
    fn a_configured_pipe_name_is_accepted_with_or_without_the_prefix() {
        let full = parse(r"\\.\pipe\custom-agent");
        assert_eq!(full.transport, Transport::NamedPipe);
        assert_eq!(full.address, r"\\.\pipe\custom-agent");

        if cfg!(windows) {
            let bare = parse("custom-agent");
            assert_eq!(bare.transport, Transport::NamedPipe);
            assert_eq!(bare.address, r"\\.\pipe\custom-agent");
        }
    }
}
