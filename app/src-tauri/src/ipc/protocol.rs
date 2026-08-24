//! IPC v1 线上信封。
//!
//! 只对信封本身建模。方法的 params/result 一律是 `serde_json::Value` 透传——DTO 建模
//! 是 NativeAOT 时代的产物（禁反射序列化导致每个字段要在三处出现），Rust 不需要，
//! 类型约束放在前端的 TypeScript interface 里。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProtocolRange {
    pub major: u32,
    #[serde(rename = "minMinor")]
    pub min_minor: u32,
    #[serde(rename = "maxMinor")]
    pub max_minor: u32,
}

#[derive(Debug, Serialize)]
pub struct Request<'a> {
    pub id: String,
    pub method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HelloParams {
    pub protocol: ProtocolVersion,
    #[serde(rename = "clientVersion")]
    pub client_version: String,
    pub capabilities: Vec<String>,
    #[serde(rename = "authToken")]
    pub auth_token: String,
    #[serde(rename = "dataRoot", skip_serializing_if = "Option::is_none")]
    pub data_root: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelloResult {
    #[serde(rename = "agentVersion")]
    pub agent_version: String,
    pub protocol: ProtocolRange,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "dataRoot")]
    pub data_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default)]
    pub details: serde_json::Value,
}

/// Agent 发来的一帧：可能是响应，也可能是事件推送。
#[derive(Debug, Clone, Deserialize)]
pub struct Incoming {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<AgentError>,
    #[serde(default, rename = "event")]
    pub event: Option<String>,
    #[serde(default)]
    pub seq: Option<i64>,
    #[serde(default, rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub revision: Option<i64>,
    #[serde(default, rename = "occurredAt")]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
}

/// 推给前端的事件。
#[derive(Debug, Clone, Serialize)]
pub struct AgentEvent {
    pub name: String,
    pub seq: Option<i64>,
    #[serde(rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(rename = "occurredAt")]
    pub occurred_at: Option<String>,
    pub payload: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_without_params_omits_the_field() {
        let request = Request {
            id: "1".into(),
            method: "accounts.list",
            params: None,
            command_id: None,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(json, r#"{"id":"1","method":"accounts.list"}"#);
    }

    #[test]
    fn hello_omits_data_root_when_absent_but_keeps_the_token() {
        let params = HelloParams {
            protocol: ProtocolVersion { major: 1, minor: 3 },
            client_version: "0.2.0".into(),
            capabilities: vec!["events".into()],
            auth_token: "secret".into(),
            data_root: None,
        };
        let json = serde_json::to_value(&params).unwrap();
        assert!(json.get("dataRoot").is_none());
        assert_eq!(json["authToken"], "secret");
        assert_eq!(json["protocol"]["minor"], 3);
    }

    #[test]
    fn an_event_frame_has_no_id_and_a_response_frame_has_one() {
        let event: Incoming = serde_json::from_str(
            r#"{"event":"account.changed","seq":7,"instanceId":"abc","payload":{"id":"a1"}}"#,
        )
        .unwrap();
        assert!(event.id.is_none());
        assert_eq!(event.event.as_deref(), Some("account.changed"));
        assert_eq!(event.seq, Some(7));

        let response: Incoming =
            serde_json::from_str(r#"{"id":"3","result":{"ok":true}}"#).unwrap();
        assert_eq!(response.id.as_deref(), Some("3"));
        assert!(response.event.is_none());
    }

    #[test]
    fn an_error_frame_keeps_the_stable_code_and_retryable_flag() {
        let incoming: Incoming = serde_json::from_str(
            r#"{"id":"4","error":{"code":"CHROME_NOT_FOUND","message":"未安装 Chrome","retryable":false}}"#,
        )
        .unwrap();
        let error = incoming.error.unwrap();
        assert_eq!(error.code, "CHROME_NOT_FOUND");
        assert!(!error.retryable);
    }

    #[test]
    fn unknown_fields_do_not_break_deserialization() {
        // 协议次版本只增加可选字段，旧客户端遇到新字段必须继续工作。
        let incoming: Incoming =
            serde_json::from_str(r#"{"id":"5","result":{},"somethingAddedInMinor9":true}"#)
                .unwrap();
        assert_eq!(incoming.id.as_deref(), Some("5"));
    }
}
