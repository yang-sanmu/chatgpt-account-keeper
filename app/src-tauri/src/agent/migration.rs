//! 迁移进度读取。
//!
//! Agent 用**追加式 JSONL** 写这个文件（Alpha 3 修的：原来是原子重命名单个 JSON，
//! 在 Windows 上和读取方抢文件句柄，一次 2.4 GB 的真实迁移把它暴露了出来）。
//!
//! 读取方必须容忍两件事：
//! 1. 最后一行可能只写了一半——追加对读者可见，但结尾换行还没到。
//! 2. 文件可能正被写入或替换。Windows 上必须显式允许共享删除，否则会让写入方失败。

use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MigrationProgress {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub error: Option<MigrationError>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MigrationError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

impl MigrationProgress {
    /// 迁移是否已经走完。Agent 在此之前不会暴露 IPC。
    pub fn is_complete(&self) -> bool {
        self.state.eq_ignore_ascii_case("succeeded") || self.stage.eq_ignore_ascii_case("completed")
    }

    pub fn is_failed(&self) -> bool {
        self.state.eq_ignore_ascii_case("failed")
    }
}

/// 取最后一条**完整**记录。
///
/// 关键点是「完整」：一次追加可能在写入终止换行之前就被读到，那一行是残缺 JSON。
/// 忽略它并回退到上一条完整记录，而不是把解析失败当成迁移失败。
pub fn last_complete_record(text: &str) -> Option<&str> {
    if text.trim().is_empty() {
        return None;
    }
    let ends_with_newline = text.ends_with('\n') || text.ends_with("\r\n");
    let mut lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();

    if !ends_with_newline {
        // 末尾没有换行：最后一段可能残缺。
        // 例外是整个文件只有一条记录且以 } 收尾——那是 Alpha 2 的单 JSON 格式，
        // 已装的用户可能还留着这种文件。
        if lines.len() == 1 {
            let only = lines[0].trim();
            return only.ends_with('}').then_some(only);
        }
        lines.pop();
    }

    lines
        .into_iter()
        .rev()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
}

/// 读一次进度。返回 `None` 表示「没有新的完整记录」，不是错误。
///
/// `last_payload` 用来去重：轮询频率远高于写入频率，不去重会把同一条记录反复推给界面。
pub fn read(
    file: &Path,
    last_payload: &mut Option<String>,
    force: bool,
) -> Option<MigrationProgress> {
    let text = read_shared(file)?;
    let payload = last_complete_record(&text)?;
    if !force && Some(payload) == last_payload.as_deref() {
        return None;
    }
    let progress = serde_json::from_str::<MigrationProgress>(payload).ok()?;
    *last_payload = Some(payload.to_string());
    Some(progress)
}

/// 以允许并发写入和删除的方式读取整个文件。
#[cfg(windows)]
fn read_shared(file: &Path) -> Option<String> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE。
    // 默认的独占读会让 Agent 的追加或替换失败——这正是 Alpha 3 的 bug。
    const SHARE_MODE: u32 = 0x1 | 0x2 | 0x4;
    let mut buffer = String::new();
    let mut handle = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(SHARE_MODE)
        .open(file)
        .ok()?;
    use std::io::Read;
    handle.read_to_string(&mut buffer).ok()?;
    Some(buffer)
}

#[cfg(not(windows))]
fn read_shared(file: &Path) -> Option<String> {
    std::fs::read_to_string(file).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_complete_record_wins() {
        let text =
            "{\"state\":\"running\",\"progress\":0.1}\n{\"state\":\"running\",\"progress\":0.5}\n";
        assert_eq!(
            last_complete_record(text),
            Some("{\"state\":\"running\",\"progress\":0.5}")
        );
    }

    #[test]
    fn an_incomplete_trailing_record_is_ignored() {
        // 这是必须容忍的核心情形：0.5 那条已完整，后面那半条还没写完换行。
        let text = "{\"state\":\"running\",\"progress\":0.5}\n{\"state\":\"run";
        assert_eq!(
            last_complete_record(text),
            Some("{\"state\":\"running\",\"progress\":0.5}")
        );
    }

    #[test]
    fn a_single_legacy_json_document_without_a_newline_is_still_read() {
        // Alpha 2 的单 JSON 格式：已装用户的 state 目录里可能还有这种文件。
        let text = "{\"state\":\"succeeded\",\"message\":\"完成\"}";
        assert_eq!(last_complete_record(text), Some(text));
    }

    #[test]
    fn a_single_incomplete_document_yields_nothing() {
        assert_eq!(last_complete_record("{\"state\":\"suc"), None);
    }

    #[test]
    fn crlf_line_endings_are_handled() {
        let text = "{\"progress\":0.1}\r\n{\"progress\":0.9}\r\n";
        assert_eq!(last_complete_record(text), Some("{\"progress\":0.9}"));
    }

    #[test]
    fn blank_trailing_lines_are_skipped() {
        let text = "{\"progress\":0.4}\n\n\n";
        assert_eq!(last_complete_record(text), Some("{\"progress\":0.4}"));
    }

    #[test]
    fn an_empty_or_whitespace_file_yields_nothing() {
        assert_eq!(last_complete_record(""), None);
        assert_eq!(last_complete_record("   \n\n"), None);
    }

    #[test]
    fn repeated_reads_deduplicate_until_forced() {
        let root = std::env::temp_dir().join(format!("keeper-mig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("migration-progress.json");
        std::fs::write(&file, "{\"state\":\"running\",\"progress\":0.25}\n").unwrap();

        let mut last = None;
        assert!(read(&file, &mut last, false).is_some());
        // 同一条记录不该反复推给界面。
        assert!(read(&file, &mut last, false).is_none());
        // 但进程退出时要能强制取一次，用来拿到最终的失败原因。
        assert!(read(&file, &mut last, true).is_some());

        std::fs::write(&file, "{\"state\":\"running\",\"progress\":0.25}\n{\"state\":\"succeeded\",\"stage\":\"completed\"}\n").unwrap();
        let progress = read(&file, &mut last, false).unwrap();
        assert!(progress.is_complete());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn completion_is_recognised_from_either_state_or_stage() {
        let by_state: MigrationProgress = serde_json::from_str(r#"{"state":"succeeded"}"#).unwrap();
        assert!(by_state.is_complete());
        let by_stage: MigrationProgress = serde_json::from_str(r#"{"stage":"completed"}"#).unwrap();
        assert!(by_stage.is_complete());
        let running: MigrationProgress =
            serde_json::from_str(r#"{"state":"running","stage":"copying"}"#).unwrap();
        assert!(!running.is_complete());
        assert!(!running.is_failed());
    }

    #[test]
    fn a_failure_record_exposes_the_stable_code() {
        let progress: MigrationProgress = serde_json::from_str(
            r#"{"state":"failed","error":{"code":"MIGRATION_TARGET_NOT_EMPTY","message":"目标已建库"}}"#,
        )
        .unwrap();
        assert!(progress.is_failed());
        assert_eq!(progress.error.unwrap().code, "MIGRATION_TARGET_NOT_EMPTY");
    }

    #[test]
    #[cfg(windows)]
    fn reads_can_run_alongside_appends_and_replacements() {
        // C# 侧的回归测试：独占读会让 Agent 的写入拿到 EBUSY/EPERM。
        let root = std::env::temp_dir().join(format!("keeper-mig-share-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("migration-progress.json");
        std::fs::write(&file, "{\"progress\":0.1}\n").unwrap();

        let mut last = None;
        let _ = read(&file, &mut last, false);
        // 读取期间与之后，追加和删除都必须仍然可行。
        {
            use std::io::Write;
            let mut appender = std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap();
            appender.write_all(b"{\"progress\":0.2}\n").unwrap();
        }
        std::fs::remove_file(&file).unwrap();

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let mut last = None;
        assert!(read(
            Path::new("/definitely/missing/progress.json"),
            &mut last,
            false
        )
        .is_none());
    }
}
