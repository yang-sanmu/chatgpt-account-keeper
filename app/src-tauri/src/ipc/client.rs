//! IPC 客户端：请求路由 + 事件分发 + 连续性检测。
//!
//! 事件连续性状态（`seq` 与 `instanceId`）必须留在这里而不是前端：前端可能被 reload，
//! 而 reload 后它无法知道自己错过了哪些事件。`seq` 出现缺口或 `instanceId` 变化时，
//! 唯一正确的动作是取一次全量 `system.bootstrap`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use super::contract::MAX_FRAME_BYTES;
use super::frame::{read_frame, write_frame, FrameError};
use super::protocol::{AgentError, AgentEvent, Incoming, Request};

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("尚未连接 Agent")]
    NotConnected,
    #[error("[{}] {}", .0.code, .0.message)]
    Agent(AgentError),
    #[error("Agent 方法 {0} 未返回 result")]
    MissingResult(String),
    #[error("Agent 返回了无法解析的帧：{0}")]
    Decode(String),
    #[error("IPC 传输失败：{0}")]
    Frame(#[from] FrameError),
    #[error("请求超时：{0}")]
    Timeout(String),
}

/// 读循环向外发出的通知。
#[derive(Debug)]
pub enum Notification {
    Event(AgentEvent),
    /// 事件序号缺口或 Agent 实例变化：必须重新取全量快照。
    ContinuityLost,
    /// 连接结束。`None` 表示对端正常关闭。
    Disconnected(Option<String>),
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Incoming>>>>;

pub struct Client {
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pending: Pending,
    next_request_id: AtomicI64,
    connected: Arc<std::sync::atomic::AtomicBool>,
}

impl Client {
    /// 接管一个已连接的流，启动读循环。
    ///
    /// 读循环持有 `pending` 的克隆：连接断开时它负责让所有在途请求立刻失败，而不是
    /// 让调用方等到超时——一个已经断开的连接上不可能再有响应到来。
    pub fn start(
        reader: Box<dyn AsyncRead + Send + Unpin>,
        writer: Box<dyn AsyncWrite + Send + Unpin>,
        notifications: mpsc::UnboundedSender<Notification>,
    ) -> Self {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));

        tokio::spawn(read_loop(
            reader,
            Arc::clone(&pending),
            notifications,
            Arc::clone(&connected),
        ));

        Self {
            writer: Arc::new(AsyncMutex::new(writer)),
            pending,
            next_request_id: AtomicI64::new(0),
            connected,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    /// 发一个请求并等响应。
    ///
    /// `command_id` 是变更类方法的幂等键：Agent 把结果在 SQLite 里留 24 小时，进程
    /// 重启后重复提交也不会重复创建。
    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
        command_id: Option<String>,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, CallError> {
        if !self.is_connected() {
            return Err(CallError::NotConnected);
        }

        let id = self
            .next_request_id
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1)
            .to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending 锁被污染");
            if pending.insert(id.clone(), sender).is_some() {
                return Err(CallError::Decode(format!("IPC request id 冲突：{id}")));
            }
        }

        // 从这里开始，任何提前返回都必须清掉 pending 项，否则一个失败的请求会永久
        // 占着 id 并让读循环拿着一个没人接的 sender。
        let outcome = self
            .send_and_wait(&id, method, params, command_id, timeout, receiver)
            .await;
        if outcome.is_err() {
            self.pending.lock().expect("pending 锁被污染").remove(&id);
        }
        outcome
    }

    async fn send_and_wait(
        &self,
        id: &str,
        method: &str,
        params: serde_json::Value,
        command_id: Option<String>,
        timeout: std::time::Duration,
        receiver: oneshot::Receiver<Incoming>,
    ) -> Result<serde_json::Value, CallError> {
        let request = Request {
            id: id.to_string(),
            method,
            params: Some(params),
            command_id,
        };
        let payload =
            serde_json::to_vec(&request).map_err(|error| CallError::Decode(error.to_string()))?;
        if payload.len() > MAX_FRAME_BYTES {
            return Err(CallError::Frame(FrameError::InvalidLength(
                payload.len() as i64
            )));
        }

        {
            // 写锁只覆盖一次完整帧：长度前缀与 payload 之间被别的写入穿插会直接
            // 让对端的解析永久错位。
            let mut writer = self.writer.lock().await;
            write_frame(&mut **writer, &payload).await?;
        }

        let incoming = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(incoming)) => incoming,
            // sender 被丢弃 = 连接断了，读循环已经清过 pending。
            Ok(Err(_)) => return Err(CallError::NotConnected),
            Err(_) => return Err(CallError::Timeout(method.to_string())),
        };

        if let Some(error) = incoming.error {
            return Err(CallError::Agent(error));
        }
        match incoming.result {
            Some(serde_json::Value::Null) | None => {
                Err(CallError::MissingResult(method.to_string()))
            }
            Some(result) => Ok(result),
        }
    }
}

async fn read_loop(
    mut reader: Box<dyn AsyncRead + Send + Unpin>,
    pending: Pending,
    notifications: mpsc::UnboundedSender<Notification>,
    connected: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut continuity = Continuity::default();
    let failure = loop {
        match read_frame(&mut reader).await {
            Ok(payload) => match serde_json::from_slice::<Incoming>(&payload) {
                Ok(incoming) => {
                    dispatch(incoming, &pending, &notifications, &mut continuity);
                }
                Err(error) => break Some(format!("Agent 返回了无法解析的 JSON：{error}")),
            },
            Err(FrameError::Closed) => break None,
            Err(error) => break Some(error.to_string()),
        }
    };

    connected.store(false, Ordering::Release);
    // 让所有在途请求立刻失败。丢弃 sender 就会让对应的 receiver 得到 RecvError，
    // 调用方那边转成 NotConnected。
    pending.lock().expect("pending 锁被污染").clear();
    let _ = notifications.send(Notification::Disconnected(failure));
}

fn dispatch(
    incoming: Incoming,
    pending: &Pending,
    notifications: &mpsc::UnboundedSender<Notification>,
    continuity: &mut Continuity,
) {
    if let Some(id) = incoming.id.clone().filter(|id| !id.trim().is_empty()) {
        if let Some(sender) = pending.lock().expect("pending 锁被污染").remove(&id) {
            let _ = sender.send(incoming);
        }
        // 没有对应的 pending 项说明请求已经超时或被取消，丢弃即可。
        return;
    }

    let Some(name) = incoming
        .event
        .clone()
        .filter(|name| !name.trim().is_empty())
    else {
        return;
    };

    if continuity.observe(incoming.instance_id.as_deref(), incoming.seq) {
        let _ = notifications.send(Notification::ContinuityLost);
    }
    let _ = notifications.send(Notification::Event(AgentEvent {
        name,
        seq: incoming.seq,
        instance_id: incoming.instance_id,
        occurred_at: incoming.occurred_at,
        payload: incoming.payload.unwrap_or(serde_json::Value::Null),
    }));
}

/// 事件连续性。`seq` 的作用域是 `instanceId`，所以实例变化时序号重新开始。
#[derive(Default)]
struct Continuity {
    instance_id: Option<String>,
    last_seq: Option<i64>,
}

impl Continuity {
    /// 返回 true 表示检测到缺口或实例变化，需要重新取全量快照。
    fn observe(&mut self, instance_id: Option<&str>, seq: Option<i64>) -> bool {
        let lost = match (&self.instance_id, instance_id) {
            // 实例换了：Agent 重启过，之前的序号不再可比，本地状态可能已经过期。
            (Some(known), Some(current)) if known != current => true,
            _ => match (self.last_seq, seq) {
                (Some(previous), Some(current)) => current != previous + 1,
                _ => false,
            },
        };
        if let Some(current) = instance_id {
            self.instance_id = Some(current.to_string());
        }
        if seq.is_some() {
            self.last_seq = seq;
        }
        lost
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consecutive_sequence_numbers_are_continuous() {
        let mut continuity = Continuity::default();
        assert!(!continuity.observe(Some("a"), Some(1)));
        assert!(!continuity.observe(Some("a"), Some(2)));
        assert!(!continuity.observe(Some("a"), Some(3)));
    }

    #[test]
    fn a_gap_in_the_sequence_is_detected() {
        let mut continuity = Continuity::default();
        assert!(!continuity.observe(Some("a"), Some(1)));
        assert!(continuity.observe(Some("a"), Some(5)));
        // 缺口之后要以新序号为基线继续，否则每一条后续事件都会重复报缺口，
        // 把界面拖进不断全量刷新的循环。
        assert!(!continuity.observe(Some("a"), Some(6)));
    }

    #[test]
    fn a_changed_instance_id_is_a_continuity_loss_even_with_a_valid_sequence() {
        let mut continuity = Continuity::default();
        assert!(!continuity.observe(Some("a"), Some(7)));
        // 新实例的序号从 8 继续也不行：Agent 重启过，本地快照可能已经陈旧。
        assert!(continuity.observe(Some("b"), Some(8)));
    }

    #[test]
    fn a_restarted_instance_resetting_its_sequence_is_detected() {
        let mut continuity = Continuity::default();
        assert!(!continuity.observe(Some("a"), Some(42)));
        assert!(continuity.observe(Some("b"), Some(1)));
        assert!(!continuity.observe(Some("b"), Some(2)));
    }

    #[test]
    fn the_first_event_is_never_a_continuity_loss() {
        let mut continuity = Continuity::default();
        assert!(!continuity.observe(Some("a"), Some(9000)));
    }

    #[test]
    fn events_without_a_sequence_do_not_break_continuity() {
        let mut continuity = Continuity::default();
        assert!(!continuity.observe(Some("a"), Some(1)));
        assert!(!continuity.observe(Some("a"), None));
        assert!(!continuity.observe(Some("a"), Some(2)));
    }

    #[tokio::test]
    async fn an_event_frame_is_forwarded_and_a_response_frame_resolves_its_request() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let mut continuity = Continuity::default();

        let (response_sender, response_receiver) = oneshot::channel();
        pending
            .lock()
            .unwrap()
            .insert("1".to_string(), response_sender);

        dispatch(
            serde_json::from_str(r#"{"event":"scheduler.changed","seq":1,"instanceId":"a","payload":{"running":true}}"#).unwrap(),
            &pending,
            &sender,
            &mut continuity,
        );
        dispatch(
            serde_json::from_str(r#"{"id":"1","result":{"ok":true}}"#).unwrap(),
            &pending,
            &sender,
            &mut continuity,
        );

        match receiver.try_recv().unwrap() {
            Notification::Event(event) => {
                assert_eq!(event.name, "scheduler.changed");
                assert_eq!(event.payload["running"], true);
            }
            other => panic!("期望事件，实际 {other:?}"),
        }
        assert_eq!(response_receiver.await.unwrap().result.unwrap()["ok"], true);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_response_for_an_unknown_id_is_dropped_without_panicking() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let mut continuity = Continuity::default();
        dispatch(
            serde_json::from_str(r#"{"id":"999","result":{}}"#).unwrap(),
            &pending,
            &sender,
            &mut continuity,
        );
        assert!(receiver.try_recv().is_err());
    }
}
