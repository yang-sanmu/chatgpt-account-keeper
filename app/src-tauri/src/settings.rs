//! 桌面自身的设置：`desktop.json`。
//!
//! 只写桌面行为，不与 Agent 的业务数据混写。它在**配置目录**而不是数据目录——切换
//! 数据目录时它必须还在，否则「重启后继续导入」那条路径会丢掉待导入的旧项目路径。

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppTheme {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    Ask,
    MinimizeToTray,
    ExitAll,
}

/// 更新策略。
///
/// 只有两档。第三档「后台下载后提醒」被去掉了：保住「点安装时已下好」必须在等待用户
/// 应答期间持有完整安装包的字节，而用户可能几小时不在机器旁。下载改到预检通过之后
/// 进行，代价只是多一条进度条。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePolicy {
    /// 发现新版本弹窗，用户确认后走完整安装流程。
    NotifyOnly,
    /// 后台等到没有登录窗口、打开的网页和运行中的任务，命中后自动安装。
    InstallAtSafePoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    pub theme: AppTheme,
    pub close_behavior: CloseBehavior,
    pub start_at_login: bool,
    /// 连接 Agent 后是否自动启动账号调度。
    pub auto_start_scheduler: bool,
    pub update_policy: UpdatePolicy,
    /// 用户选择「忽略本次更新」的版本号。只压制这一个版本，更高版本仍会提示。
    pub ignored_update_version: Option<String>,
    /// 待执行的旧项目导入源目录。
    ///
    /// 首次启动后再导入必须换一个空数据目录，而换目录要重启进程才生效，所以待导入的
    /// 旧项目根目录要写在这里（配置目录，不随数据目录切换）。
    pub pending_legacy_import_root: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: AppTheme::Dark,
            close_behavior: CloseBehavior::Ask,
            start_at_login: false,
            auto_start_scheduler: false,
            update_policy: UpdatePolicy::NotifyOnly,
            ignored_update_version: None,
            pending_legacy_import_root: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("读写桌面设置失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("序列化桌面设置失败：{0}")]
    Serialize(#[from] serde_json::Error),
}

/// 读设置。损坏的文件回落到默认值而不是让程序起不来。
///
/// 这里面没有任何数据是不可重建的（主题、关闭行为、窗口偏好），用默认值继续远好过
/// 因为一个坏了的偏好文件打不开管理界面。
pub fn load(file: &Path) -> DesktopSettings {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => DesktopSettings::default(),
    }
}

/// 原子写入：临时文件 + 重命名。
pub fn save(file: &Path, settings: &DesktopSettings) -> Result<(), SettingsError> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_vec_pretty(settings)?;
    let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| -> Result<(), SettingsError> {
        std::fs::write(&temporary, &payload)?;
        std::fs::rename(&temporary, file)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_file() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("keeper-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root.join("desktop.json")
    }

    #[test]
    fn defaults_are_conservative() {
        let settings = DesktopSettings::default();
        // 开机自启和自动调度默认关：装完就开始跑真实账号不该是默认行为。
        assert!(!settings.start_at_login);
        assert!(!settings.auto_start_scheduler);
        // 更新默认只提醒，不自动装。
        assert_eq!(settings.update_policy, UpdatePolicy::NotifyOnly);
        assert_eq!(settings.close_behavior, CloseBehavior::Ask);
    }

    #[test]
    fn a_missing_file_yields_defaults() {
        let file = temporary_file();
        let settings = load(&file);
        assert_eq!(settings.theme, AppTheme::Dark);
        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn a_corrupted_file_yields_defaults_rather_than_failing_startup() {
        let file = temporary_file();
        std::fs::write(&file, "{ this is not json").unwrap();
        let settings = load(&file);
        assert_eq!(settings.theme, AppTheme::Dark);
        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn a_partial_file_keeps_the_known_fields_and_defaults_the_rest() {
        // 版本升级会加字段。旧文件必须继续可读，否则一次升级会重置所有偏好。
        let file = temporary_file();
        std::fs::write(&file, r#"{"theme":"light","startAtLogin":true}"#).unwrap();
        let settings = load(&file);
        assert_eq!(settings.theme, AppTheme::Light);
        assert!(settings.start_at_login);
        assert_eq!(settings.update_policy, UpdatePolicy::NotifyOnly);
        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn the_ignored_version_and_pending_import_survive_a_round_trip() {
        // 这两个是「重启后继续做」的载体，丢了会让用户重新选一次旧项目目录。
        let file = temporary_file();
        let settings = DesktopSettings {
            ignored_update_version: Some("0.2.5".into()),
            pending_legacy_import_root: Some(if cfg!(windows) {
                r"D:\old-keeper".to_string()
            } else {
                "/data/old-keeper".to_string()
            }),
            ..Default::default()
        };
        save(&file, &settings).unwrap();

        let restored = load(&file);
        assert_eq!(restored.ignored_update_version.as_deref(), Some("0.2.5"));
        assert_eq!(
            restored.pending_legacy_import_root,
            settings.pending_legacy_import_root
        );
        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn saving_leaves_no_temporary_file() {
        let file = temporary_file();
        save(&file, &DesktopSettings::default()).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留：{leftovers:?}");
        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn the_update_policy_has_exactly_two_variants_on_the_wire() {
        // 第三档被刻意移除。如果哪天加回来，这条测试会提醒同时更新计划文档里的理由。
        assert_eq!(
            serde_json::to_string(&UpdatePolicy::NotifyOnly).unwrap(),
            "\"notifyOnly\""
        );
        assert_eq!(
            serde_json::to_string(&UpdatePolicy::InstallAtSafePoint).unwrap(),
            "\"installAtSafePoint\""
        );
        assert!(serde_json::from_str::<UpdatePolicy>("\"downloadAndPrompt\"").is_err());
    }
}
