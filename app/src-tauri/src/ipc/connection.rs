//! 连接编排：hello 协商、数据目录一致性、按需启动 Agent、断线重连。
//!
//! 这一层是 Rust 独占的。前端不能调 `system.hello`/`system.bootstrap`——凭据不进
//! WebView，而 bootstrap 快照的时机（连上、seq 缺口、实例变化）由这里决定。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};

use super::client::{CallError, Client, Notification};
use super::contract::{is_ui_method, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use super::endpoint::{canonical_data_root, Endpoint};
use super::protocol::{HelloParams, HelloResult, ProtocolVersion};
use super::transport::{self, TransportError};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(700);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Agent 可能在迁移大 Profile，启动轮询要足够久。
const START_POLL_ATTEMPTS: u32 = 30;
const START_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("Agent IPC 尚未就绪：{0}")]
    NotReady(String),
    #[error("{0}")]
    Transport(#[from] TransportError),
    #[error("{0}")]
    Call(#[from] CallError),
    #[error("协议不兼容：客户端 v{client}，Agent v{agent}")]
    ProtocolMajor { client: u32, agent: u32 },
    #[error("协议次版本不兼容：客户端 v{major}.{requested}，Agent 支持 {major}.{min}-{max}")]
    ProtocolMinor {
        major: u32,
        requested: u32,
        min: u32,
        max: u32,
    },
    #[error("Agent 数据目录不匹配：客户端={client}，Agent={agent}")]
    DataRootMismatch { client: String, agent: String },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionSnapshot {
    pub connected: bool,
    pub status: String,
    pub detail: String,
    #[serde(rename = "agentVersion")]
    pub agent_version: Option<String>,
    #[serde(rename = "instanceId")]
    pub instance_id: Option<String>,
}

impl ConnectionSnapshot {
    fn disconnected(status: &str, detail: impl Into<String>) -> Self {
        Self {
            connected: false,
            status: status.to_string(),
            detail: detail.into(),
            agent_version: None,
            instance_id: None,
        }
    }
}

pub struct Connection {
    endpoint: Endpoint,
    data_root: String,
    ipc_credential: String,
    client_version: String,
    client: Mutex<Option<Arc<Client>>>,
}

impl Connection {
    pub fn new(
        endpoint: Endpoint,
        data_root: &Path,
        ipc_credential: String,
        client_version: String,
    ) -> Self {
        Self {
            endpoint,
            data_root: canonical_data_root(data_root),
            ipc_credential,
            client_version,
            client: Mutex::new(None),
        }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub async fn is_connected(&self) -> bool {
        matches!(self.client.lock().await.as_ref(), Some(client) if client.is_connected())
    }

    /// 前端发起的调用。方法名必须在 UI 白名单内。
    ///
    /// 这道检查是 Rust/前端边界的实现：`system.*` 不在白名单里，所以前端无法绕过
    /// 连接协商、更新编排和退出流程。
    pub async fn call_from_ui(
        &self,
        method: &str,
        params: serde_json::Value,
        command_id: Option<String>,
    ) -> Result<serde_json::Value, CallError> {
        if !is_ui_method(method) {
            return Err(CallError::Agent(super::protocol::AgentError {
                code: "VALIDATION_FAILED".into(),
                message: format!("方法 {method} 不对界面开放"),
                retryable: false,
                details: serde_json::Value::Null,
            }));
        }
        self.call_internal(method, params, command_id).await
    }

    /// Rust 内部调用，不受 UI 白名单限制。
    pub async fn call_internal(
        &self,
        method: &str,
        params: serde_json::Value,
        command_id: Option<String>,
    ) -> Result<serde_json::Value, CallError> {
        let client = {
            let guard = self.client.lock().await;
            guard.as_ref().cloned().ok_or(CallError::NotConnected)?
        };
        client.call(method, params, command_id, CALL_TIMEOUT).await
    }

    /// 连一次并完成 hello 协商。
    pub async fn connect(
        &self,
        notifications: mpsc::UnboundedSender<Notification>,
    ) -> Result<ConnectionSnapshot, ConnectError> {
        let mut guard = self.client.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.is_connected() {
                return Ok(ConnectionSnapshot {
                    connected: true,
                    status: "Agent 已连接".into(),
                    detail: self.endpoint.display_name().into(),
                    agent_version: None,
                    instance_id: None,
                });
            }
        }
        *guard = None;

        if !transport::is_available(&self.endpoint) {
            return Err(ConnectError::NotReady(
                self.endpoint.display_name().to_string(),
            ));
        }

        let stream = transport::connect(&self.endpoint, CONNECT_TIMEOUT).await?;
        let (reader, writer) = stream.split();
        let client = Arc::new(Client::start(reader, writer, notifications));

        let hello = self.negotiate(&client).await?;
        *guard = Some(client);

        Ok(ConnectionSnapshot {
            connected: true,
            status: "Agent 已连接".into(),
            detail: format!(
                "协议 {}.{} · 实例 {}",
                hello.protocol.major, hello.protocol.max_minor, hello.instance_id
            ),
            agent_version: Some(hello.agent_version),
            instance_id: Some(hello.instance_id),
        })
    }

    async fn negotiate(&self, client: &Client) -> Result<HelloResult, ConnectError> {
        let params = HelloParams {
            protocol: ProtocolVersion {
                major: PROTOCOL_MAJOR,
                minor: PROTOCOL_MINOR,
            },
            client_version: self.client_version.clone(),
            capabilities: vec!["events".into(), "native-desktop".into(), "tray".into()],
            auth_token: self.ipc_credential.clone(),
            data_root: Some(self.data_root.clone()),
        };
        let result = client
            .call(
                "system.hello",
                serde_json::to_value(&params).expect("hello 参数必定可序列化"),
                None,
                CONNECT_TIMEOUT + Duration::from_secs(5),
            )
            .await?;
        let hello: HelloResult =
            serde_json::from_value(result).map_err(|error| CallError::Decode(error.to_string()))?;

        verify_protocol(&hello, PROTOCOL_MAJOR, PROTOCOL_MINOR)?;
        verify_data_root(hello.data_root.as_deref(), &self.data_root)?;
        Ok(hello)
    }

    /// 连不上就启动 Agent，然后轮询等它建立 IPC。
    ///
    /// `start_when_unavailable = false` 用于「退出全部」和更新安装：它们要接回已有
    /// Agent，但**绝不为了退出而启动一个新的**。
    pub async fn ensure_connected<F>(
        &self,
        start_when_unavailable: bool,
        notifications: mpsc::UnboundedSender<Notification>,
        mut start_agent: F,
    ) -> ConnectionSnapshot
    where
        F: FnMut() -> Result<(), String>,
    {
        match self.connect(notifications.clone()).await {
            Ok(snapshot) => return snapshot,
            Err(error) => {
                if !start_when_unavailable {
                    return ConnectionSnapshot::disconnected("未连接", error.to_string());
                }
            }
        }

        if let Err(message) = start_agent() {
            return ConnectionSnapshot::disconnected("Agent 启动失败", message);
        }

        let mut last = String::from("已启动 Agent，但未能在限定时间内建立 IPC");
        for _ in 0..START_POLL_ATTEMPTS {
            tokio::time::sleep(START_POLL_INTERVAL).await;
            match self.connect(notifications.clone()).await {
                Ok(snapshot) => return snapshot,
                Err(error) => last = error.to_string(),
            }
        }
        ConnectionSnapshot::disconnected("Agent 无响应", last)
    }

    /// 主动断开。用于「退出全部」之后，避免重连循环把 Agent 又拉起来。
    pub async fn disconnect(&self) {
        *self.client.lock().await = None;
    }
}

/// 重连退避序列（秒）。与 C# 版一致。
pub const RECONNECT_BACKOFF_SECONDS: &[u64] = &[1, 2, 5, 10, 20, 30];

fn verify_protocol(hello: &HelloResult, major: u32, requested: u32) -> Result<(), ConnectError> {
    if hello.protocol.major != major {
        return Err(ConnectError::ProtocolMajor {
            client: major,
            agent: hello.protocol.major,
        });
    }
    if requested < hello.protocol.min_minor || requested > hello.protocol.max_minor {
        return Err(ConnectError::ProtocolMinor {
            major,
            requested,
            min: hello.protocol.min_minor,
            max: hello.protocol.max_minor,
        });
    }
    Ok(())
}

/// 数据目录一致性。
///
/// Agent 必须报告数据根，且必须与我们的一致。不报告就拒绝连接：那说明它是一个更老的
/// Agent，无法确认它在操作哪个数据目录，而连错目录会让界面显示 A 的账号却改 B 的数据。
fn verify_data_root(reported: Option<&str>, expected: &str) -> Result<(), ConnectError> {
    let Some(reported) = reported.filter(|value| !value.trim().is_empty()) else {
        return Err(ConnectError::DataRootMismatch {
            client: expected.to_string(),
            agent: "未报告".to_string(),
        });
    };
    if canonical_data_root(Path::new(reported)) != expected {
        return Err(ConnectError::DataRootMismatch {
            client: expected.to_string(),
            agent: reported.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::ProtocolRange;

    fn hello(major: u32, min_minor: u32, max_minor: u32, data_root: Option<&str>) -> HelloResult {
        HelloResult {
            agent_version: "0.2.0".into(),
            protocol: ProtocolRange {
                major,
                min_minor,
                max_minor,
            },
            capabilities: vec![],
            instance_id: "instance-1".into(),
            data_root: data_root.map(str::to_string),
        }
    }

    #[test]
    fn a_matching_protocol_is_accepted() {
        verify_protocol(&hello(1, 0, 3, None), 1, 3).unwrap();
        // Agent 支持到更高的次版本也没问题：我们请求 3，它支持 0-5。
        verify_protocol(&hello(1, 0, 5, None), 1, 3).unwrap();
    }

    #[test]
    fn a_different_major_version_is_rejected() {
        let error = verify_protocol(&hello(2, 0, 0, None), 1, 3).unwrap_err();
        assert!(
            matches!(error, ConnectError::ProtocolMajor { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn requesting_a_minor_above_the_agent_range_is_rejected() {
        // 我们要 3，Agent 只到 1：它没有 queue.getSnapshot / browserRuns.*，
        // 连上去之后界面会在运行期拿到 INTERNAL 而不是启动期失败。
        let error = verify_protocol(&hello(1, 0, 1, None), 1, 3).unwrap_err();
        assert!(
            matches!(error, ConnectError::ProtocolMinor { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn requesting_a_minor_below_the_agent_minimum_is_rejected() {
        let error = verify_protocol(&hello(1, 4, 6, None), 1, 3).unwrap_err();
        assert!(
            matches!(error, ConnectError::ProtocolMinor { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn a_matching_data_root_is_accepted() {
        let expected = canonical_data_root(Path::new(if cfg!(windows) {
            r"C:\data\keeper"
        } else {
            "/data/keeper"
        }));
        verify_data_root(
            Some(if cfg!(windows) {
                r"C:\data\keeper"
            } else {
                "/data/keeper"
            }),
            &expected,
        )
        .unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn data_root_comparison_tolerates_case_and_separator_differences() {
        let expected = canonical_data_root(Path::new(r"C:\Data\Keeper"));
        verify_data_root(Some(r"c:\data\keeper\"), &expected).unwrap();
    }

    #[test]
    fn a_mismatched_data_root_is_rejected() {
        let expected = canonical_data_root(Path::new(if cfg!(windows) {
            r"C:\data\keeper-a"
        } else {
            "/data/keeper-a"
        }));
        let error = verify_data_root(
            Some(if cfg!(windows) {
                r"C:\data\keeper-b"
            } else {
                "/data/keeper-b"
            }),
            &expected,
        )
        .unwrap_err();
        assert!(
            matches!(error, ConnectError::DataRootMismatch { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn an_agent_that_does_not_report_its_data_root_is_rejected() {
        // 不能默认「它大概是对的」：连错数据目录会让界面显示 A 的账号却改 B 的数据。
        let error = verify_data_root(None, "X").unwrap_err();
        assert!(
            matches!(error, ConnectError::DataRootMismatch { .. }),
            "{error:?}"
        );
        assert!(verify_data_root(Some("   "), "X").is_err());
    }

    #[tokio::test]
    async fn a_system_method_from_the_ui_is_refused_before_any_transport_work() {
        let connection = Connection::new(
            Endpoint {
                transport: crate::ipc::endpoint::Transport::NamedPipe,
                address: r"\\.\pipe\keeper-never-created".into(),
            },
            Path::new(if cfg!(windows) {
                r"C:\data\keeper"
            } else {
                "/data/keeper"
            }),
            "token".into(),
            "0.2.0".into(),
        );

        // 未连接时，UI 白名单外的方法必须报「不对界面开放」而不是「尚未连接」——
        // 前者才是真正的原因，后者会让人以为连上就能调。
        for method in crate::ipc::contract::INTERNAL_METHODS {
            let error = connection
                .call_from_ui(method, serde_json::json!({}), None)
                .await
                .unwrap_err();
            match error {
                CallError::Agent(agent) => {
                    assert_eq!(agent.code, "VALIDATION_FAILED");
                    assert!(agent.message.contains("不对界面开放"), "{}", agent.message);
                }
                other => panic!("{method} 应被白名单拒绝，实际 {other:?}"),
            }
        }

        // 白名单内的方法在未连接时才报 NotConnected。
        let error = connection
            .call_from_ui("accounts.list", serde_json::json!({}), None)
            .await
            .unwrap_err();
        assert!(matches!(error, CallError::NotConnected), "{error:?}");
    }

    #[tokio::test]
    async fn ensure_connected_without_start_permission_never_starts_an_agent() {
        // 「退出全部」和更新安装走这条路径：它们要接回已有 Agent，但绝不能为了退出
        // 而启动一个新的。
        let connection = Connection::new(
            Endpoint {
                transport: if cfg!(windows) {
                    crate::ipc::endpoint::Transport::NamedPipe
                } else {
                    crate::ipc::endpoint::Transport::UnixSocket
                },
                address: if cfg!(windows) {
                    format!(r"\\.\pipe\keeper-absent-{}", uuid::Uuid::new_v4())
                } else {
                    format!("/tmp/keeper-absent-{}.sock", uuid::Uuid::new_v4())
                },
            },
            Path::new(if cfg!(windows) {
                r"C:\data\keeper"
            } else {
                "/data/keeper"
            }),
            "token".into(),
            "0.2.0".into(),
        );

        let (sender, _receiver) = mpsc::unbounded_channel();
        let mut started = false;
        let snapshot = connection
            .ensure_connected(false, sender, || {
                started = true;
                Ok(())
            })
            .await;

        assert!(!snapshot.connected);
        assert!(!started, "startWhenUnavailable=false 时绝不能启动 Agent");
    }

    #[test]
    fn the_reconnect_backoff_is_bounded_and_increasing() {
        assert_eq!(RECONNECT_BACKOFF_SECONDS, &[1, 2, 5, 10, 20, 30]);
        assert!(RECONNECT_BACKOFF_SECONDS
            .windows(2)
            .all(|pair| pair[0] < pair[1]));
    }
}
