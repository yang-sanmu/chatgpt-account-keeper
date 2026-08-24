//! IPC v1 契约常量。
//!
//! 这些常量必须与 `contracts/ipc-v1.schema.json` 完全一致。本模块底部的测试直接
//! 读那个 schema 做断言——契约漂移要在测试期炸掉，而不是运行期被 Agent 的出站契约
//! 校验判成 `INTERNAL` 然后销毁 socket。

/// 协议主版本。不同主版本不兼容。
pub const PROTOCOL_MAJOR: u32 = 1;
/// 协议次版本。次版本只增加可选字段、方法、事件或能力。
pub const PROTOCOL_MINOR: u32 = 3;
/// 帧长度上限。超过它必须在分配 payload 缓冲区之前拒绝。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// 只由 Rust 调用的方法。
///
/// 前端能调它们等于能绕过连接协商、更新编排和退出流程——与「Rust 持有生命周期
/// 语义」直接冲突。`system.bootstrap` 也在这里：全量快照由 Rust 在连接成功和检测到
/// seq 缺口时主动取，再推给前端。
pub const INTERNAL_METHODS: &[&str] = &[
    "system.hello",
    "system.bootstrap",
    "system.getActivity",
    "system.prepareUpdate",
    "system.shutdown",
];

/// 前端可经 `agent_call` 调用的业务方法。
pub const UI_METHODS: &[&str] = &[
    "accounts.list",
    "accounts.create",
    "accounts.update",
    "accounts.remove",
    "accounts.getStatus",
    "accounts.refreshStatus",
    "accounts.runNow",
    "accounts.checkSelectors",
    "browser.startLogin",
    "browser.getTask",
    "browser.openPage",
    "browser.closePage",
    "browser.listOpenPages",
    "accounts.history",
    "history.query",
    "history.listAccounts",
    "groups.list",
    "groups.create",
    "groups.update",
    "groups.remove",
    "proxies.getState",
    "proxies.importSubscription",
    "proxies.refreshSubscription",
    "proxies.setRuntimeDirectory",
    "proxies.setNodeEnabled",
    "proxies.testNode",
    "proxies.testAll",
    "profiles.scan",
    "profiles.cleanCache",
    "profiles.archiveOrphan",
    "profiles.purgeOrphan",
    "conversations.list",
    "conversations.upsert",
    "conversations.remove",
    "scheduler.getState",
    "scheduler.start",
    "scheduler.stop",
    "settings.get",
    "settings.update",
    "operations.get",
    "operations.listActive",
    "operations.list",
    "queue.getSnapshot",
    "browserRuns.list",
    "browserRuns.close",
];

/// Agent 推送的事件名。
pub const EVENT_NAMES: &[&str] = &[
    "account.changed",
    "account.removed",
    "accountStatus.changed",
    "openPage.changed",
    "operation.changed",
    "group.changed",
    "proxyState.changed",
    "proxyNode.tested",
    "profile.changed",
    "conversation.changed",
    "scheduler.changed",
    "scheduler.accountChanged",
    "history.appended",
    "settings.changed",
    "agent.draining",
    "agent.readyForUpdate",
    "queue.changed",
    "browserRun.changed",
];

/// 稳定错误码。用户和日志都靠它定位问题，必须原样透出到界面。
pub const ERROR_CODES: &[&str] = &[
    "VALIDATION_FAILED",
    "NOT_FOUND",
    "RESOURCE_BUSY",
    "PROFILE_IN_USE",
    "PROXY_UNAVAILABLE",
    "ALREADY_OPEN",
    "LOGIN_FORCE_CONFLICT",
    "CHROME_NOT_FOUND",
    "AGENT_DRAINING",
    "PROTOCOL_MISMATCH",
    "FRAME_TOO_LARGE",
    "INTERNAL",
];

/// 前端请求的方法是否允许。
pub fn is_ui_method(method: &str) -> bool {
    UI_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn schema() -> serde_json::Value {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/ipc-v1.schema.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("读取 {} 失败：{error}", path.display()));
        serde_json::from_str(&text).expect("契约不是合法 JSON")
    }

    fn schema_enum(name: &str) -> BTreeSet<String> {
        schema()["$defs"][name]["enum"]
            .as_array()
            .unwrap_or_else(|| panic!("契约里 $defs.{name}.enum 不存在"))
            .iter()
            .map(|value| value.as_str().expect("enum 项必须是字符串").to_string())
            .collect()
    }

    fn set(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn internal_and_ui_methods_partition_the_contract() {
        let internal = set(INTERNAL_METHODS);
        let ui = set(UI_METHODS);

        // 交集为空：前端绝不能拿到生命周期方法。
        let overlap: Vec<_> = internal.intersection(&ui).collect();
        assert!(overlap.is_empty(), "两组方法有交集：{overlap:?}");

        // 并集等于契约：漏掉一个方法就意味着某个界面功能永远调不通。
        let union: BTreeSet<String> = internal.union(&ui).cloned().collect();
        assert_eq!(union, schema_enum("method"));

        // 数量固定，防止有人一边加一边删还让上面两条都过。
        assert_eq!(INTERNAL_METHODS.len(), 5);
        assert_eq!(UI_METHODS.len(), 45);
    }

    #[test]
    fn no_duplicate_entries() {
        assert_eq!(set(INTERNAL_METHODS).len(), INTERNAL_METHODS.len());
        assert_eq!(set(UI_METHODS).len(), UI_METHODS.len());
        assert_eq!(set(EVENT_NAMES).len(), EVENT_NAMES.len());
        assert_eq!(set(ERROR_CODES).len(), ERROR_CODES.len());
    }

    #[test]
    fn event_names_match_the_contract() {
        assert_eq!(set(EVENT_NAMES), schema_enum("eventName"));
    }

    #[test]
    fn error_codes_match_the_contract() {
        assert_eq!(set(ERROR_CODES), schema_enum("errorCode"));
    }

    #[test]
    fn system_methods_are_never_reachable_from_the_frontend() {
        for method in INTERNAL_METHODS {
            assert!(!is_ui_method(method), "{method} 不该对前端开放");
        }
        assert!(is_ui_method("accounts.list"));
        assert!(!is_ui_method("accounts.listAllSecrets"));
    }
}
