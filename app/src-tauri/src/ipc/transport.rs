//! 平台传输：Windows 命名管道 / Unix 域套接字。
//!
//! 「端点尚未创建」是启动期的**正常**结果，不是故障：Agent 在迁移大 Profile 时可能
//! 几十秒后才开始监听。这里把它归成 `NotReady`，让上层安静重试。

use std::path::Path;

use tokio::io::{AsyncRead, AsyncWrite};

use super::endpoint::{Endpoint, Transport};

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// 端点还不存在或全部实例忙。上层据此安静重试，不打日志、不提示用户。
    #[error("Agent IPC 尚未就绪：{0}")]
    NotReady(String),
    #[error("连接 Agent IPC 超时：{0}")]
    Timeout(String),
    #[error("连接 Agent IPC 失败：{0}")]
    Io(#[from] std::io::Error),
}

/// 一个已连接的双向流。
#[derive(Debug)]
pub enum Stream {
    #[cfg(windows)]
    Pipe(tokio::net::windows::named_pipe::NamedPipeClient),
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
}

impl Stream {
    /// 拆成读写两半，让读循环与写入各自独立持有。
    pub fn split(
        self,
    ) -> (
        Box<dyn AsyncRead + Send + Unpin>,
        Box<dyn AsyncWrite + Send + Unpin>,
    ) {
        match self {
            #[cfg(windows)]
            Stream::Pipe(pipe) => {
                let (reader, writer) = tokio::io::split(pipe);
                (Box::new(reader), Box::new(writer))
            }
            #[cfg(unix)]
            Stream::Unix(socket) => {
                let (reader, writer) = socket.into_split();
                (Box::new(reader), Box::new(writer))
            }
        }
    }
}

/// 端点当前是否可能接受连接。
///
/// 只做一次廉价探测，用来在启动轮询期间避免产生真正的连接错误。返回 true 不保证
/// 随后的 connect 一定成功。
pub fn is_available(endpoint: &Endpoint) -> bool {
    match endpoint.transport {
        #[cfg(windows)]
        Transport::NamedPipe => {
            // Rust 侧不需要 C# 那套 WaitNamedPipe(name, 0) 规避首发异常刷屏的处理：
            // 这里「不存在」就是一个普通的 Err，不是 TimeoutException，也不会在
            // 调试器里刷 first-chance 异常。直接看路径是否存在即可。
            Path::new(&endpoint.address).exists()
        }
        #[cfg(unix)]
        Transport::UnixSocket => Path::new(&endpoint.address).exists(),
        #[cfg(not(windows))]
        Transport::NamedPipe => false,
        #[cfg(not(unix))]
        Transport::UnixSocket => false,
    }
}

/// 连接端点。`timeout` 只覆盖连接本身。
pub async fn connect(
    endpoint: &Endpoint,
    timeout: std::time::Duration,
) -> Result<Stream, TransportError> {
    match endpoint.transport {
        #[cfg(windows)]
        Transport::NamedPipe => connect_pipe(&endpoint.address, timeout).await,
        #[cfg(unix)]
        Transport::UnixSocket => connect_unix(&endpoint.address, timeout).await,
        #[cfg(not(windows))]
        Transport::NamedPipe => Err(TransportError::NotReady(endpoint.address.clone())),
        #[cfg(not(unix))]
        Transport::UnixSocket => Err(TransportError::NotReady(endpoint.address.clone())),
    }
}

#[cfg(windows)]
async fn connect_pipe(
    address: &str,
    timeout: std::time::Duration,
) -> Result<Stream, TransportError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match ClientOptions::new().open(address) {
            Ok(client) => return Ok(Stream::Pipe(client)),
            Err(error) => {
                let code = error.raw_os_error().unwrap_or_default() as u32;
                // ERROR_PIPE_BUSY：管道存在但所有实例都忙，等一下必然可用。
                // ERROR_FILE_NOT_FOUND：还没创建，可能 Agent 正在迁移数据。
                if code != ERROR_PIPE_BUSY.0 && code != ERROR_FILE_NOT_FOUND.0 {
                    return Err(TransportError::Io(error));
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(if code == ERROR_FILE_NOT_FOUND.0 {
                        TransportError::NotReady(address.to_string())
                    } else {
                        TransportError::Timeout(address.to_string())
                    });
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
}

#[cfg(unix)]
async fn connect_unix(
    address: &str,
    timeout: std::time::Duration,
) -> Result<Stream, TransportError> {
    match tokio::time::timeout(timeout, tokio::net::UnixStream::connect(address)).await {
        Ok(Ok(socket)) => Ok(Stream::Unix(socket)),
        Ok(Err(error)) => {
            // 陈旧 socket 文件（Agent 被 kill -9）表现为 ECONNREFUSED；文件不存在是
            // ENOENT。两者都是「还没就绪」，上层重试即可。
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) {
                Err(TransportError::NotReady(address.to_string()))
            } else {
                Err(TransportError::Io(error))
            }
        }
        Err(_) => Err(TransportError::Timeout(address.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn missing_endpoint() -> Endpoint {
        if cfg!(windows) {
            Endpoint {
                transport: Transport::NamedPipe,
                address: format!(r"\\.\pipe\keeper-test-missing-{}", uuid::Uuid::new_v4()),
            }
        } else {
            Endpoint {
                transport: Transport::UnixSocket,
                address: format!("/tmp/keeper-test-missing-{}.sock", uuid::Uuid::new_v4()),
            }
        }
    }

    #[test]
    fn a_never_created_endpoint_is_reported_unavailable() {
        assert!(!is_available(&missing_endpoint()));
    }

    #[tokio::test]
    async fn connecting_to_a_missing_endpoint_reports_not_ready_rather_than_io_failure() {
        // 这条对应 C# 侧那个「探测未创建的管道不该抛 TimeoutException」的回归测试。
        // 在 Rust 里它必须是一个可判别的 NotReady，否则启动轮询会把正常的等待
        // 当成故障提示给用户。
        let error = connect(&missing_endpoint(), Duration::from_millis(150))
            .await
            .unwrap_err();
        assert!(
            matches!(error, TransportError::NotReady(_)),
            "期望 NotReady，实际 {error:?}"
        );
    }
}
