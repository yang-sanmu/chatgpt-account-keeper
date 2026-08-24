//! 更新提示决策。
//!
//! 这里只放**与网络和 Velopack/Tauri 无关**的那部分规则，因为它们是唯一能脱离真实
//! 安装上下文测试的部分。真正的 check/download/install 编排在 commands.rs 里，它需要
//! 一个 Tauri AppHandle。
//!
//! 只保留三条行为（对应旧 UpdateGate 的实质）：
//! 1. 「忽略本次更新」只压制那一个版本，更高版本仍会提示。
//! 2. 手动检查始终弹窗——否则用户点了「检查更新」界面上什么都不发生。
//! 3. 自动检查不对同一版本重复提示。
//!
//! 旧 UpdateGate 里那套「已下载状态不能被降级」的折叠逻辑**不需要**了：它的复杂度
//! 来自 VeloPack 的两个具体缺陷（一次检查会把已下载降级、进度回调迟到覆盖状态）。
//! 现在下载发生在预检通过之后、且结果就是我们手里的一段 bytes，那些分支不可达。

#[derive(Debug, Default)]
pub struct UpdatePrompts {
    /// 用户持久忽略的版本。
    ignored: Option<String>,
    /// 本次会话已提示过的版本。「下次启动提醒」只压制到进程结束。
    prompted: Option<String>,
}

fn normalize(version: Option<&str>) -> Option<String> {
    version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn same(left: Option<&String>, right: &str) -> bool {
    left.is_some_and(|value| value.eq_ignore_ascii_case(right))
}

impl UpdatePrompts {
    pub fn with_ignored(version: Option<&str>) -> Self {
        Self {
            ignored: normalize(version),
            prompted: None,
        }
    }

    pub fn ignored_version(&self) -> Option<&str> {
        self.ignored.as_deref()
    }

    /// 「忽略本次更新」：持久压制这一个版本。
    pub fn ignore(&mut self, version: Option<&str>) {
        self.ignored = normalize(version);
    }

    /// 「下次启动提醒」：只压制本次会话。
    pub fn defer(&mut self, version: Option<&str>) {
        self.prompted = normalize(version);
    }

    pub fn mark_prompted(&mut self, version: Option<&str>) {
        self.prompted = normalize(version);
    }

    /// 是否应该弹窗。
    pub fn should_prompt(&self, version: Option<&str>, manual: bool) -> bool {
        let Some(version) = normalize(version) else {
            return false;
        };
        // 手动检查始终弹：否则用户点了按钮什么都不发生，会以为程序坏了。
        if manual {
            return true;
        }
        if same(self.ignored.as_ref(), &version) {
            return false;
        }
        !same(self.prompted.as_ref(), &version)
    }
}

/// 安装流程的阶段。取消只在前两个阶段可用。
///
/// 排空提交之后不可取消：Agent 已经进入拒绝写入的状态，必须走完，否则本次会话会停在
/// 一个半停机状态——能看不能改。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStage {
    /// 预检阻塞项（Chrome 窗口、运行中的任务）。可取消。
    Preflight,
    /// 下载安装包。可取消。
    Downloading,
    /// 排空 Agent + SQLite 检查点。不可取消。
    Draining,
    /// 等 Agent 释放数据库和 Profile 句柄。不可取消。
    StoppingAgent,
    /// 安装。Windows 会在这里内部退出进程；macOS/Linux 需要我们自己重启。
    Installing,
}

impl InstallStage {
    pub fn can_cancel(self) -> bool {
        matches!(self, InstallStage::Preflight | InstallStage::Downloading)
    }

    pub fn message(self) -> &'static str {
        match self {
            InstallStage::Preflight => "正在检查安装条件：Chrome 窗口、运行任务和数据目录状态",
            InstallStage::Downloading => "正在下载更新包",
            InstallStage::Draining => "正在安全排空 Agent：完成任务收尾和数据库检查点",
            InstallStage::StoppingAgent => "正在等待 Agent 释放数据库和 Profile 句柄",
            InstallStage::Installing => "正在安装更新并重启",
        }
    }
}

/// `install()` 之后是否需要我们自己重启进程。
///
/// Windows 上 tauri-plugin-updater 的 `install()` 内部会 `std::process::exit(0)` 并由
/// NSIS 重启；macOS 与 Linux 上它返回后进程还在，必须显式 relaunch，否则用户会以为
/// 更新失败了。
pub const fn needs_explicit_relaunch() -> bool {
    !cfg!(windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignoring_a_version_suppresses_only_that_version() {
        let mut prompts = UpdatePrompts::default();
        prompts.ignore(Some("0.2.5"));
        assert!(!prompts.should_prompt(Some("0.2.5"), false));
        // 更高版本仍然要提示，否则一次「忽略」等于永久关掉更新。
        assert!(prompts.should_prompt(Some("0.2.6"), false));
    }

    #[test]
    fn a_manual_check_always_prompts_even_for_an_ignored_version() {
        let mut prompts = UpdatePrompts::default();
        prompts.ignore(Some("0.2.5"));
        prompts.mark_prompted(Some("0.2.5"));
        assert!(prompts.should_prompt(Some("0.2.5"), true));
    }

    #[test]
    fn an_automatic_recheck_does_not_prompt_twice_for_the_same_version() {
        let mut prompts = UpdatePrompts::default();
        assert!(prompts.should_prompt(Some("0.2.6"), false));
        prompts.mark_prompted(Some("0.2.6"));
        // 后台每 30 分钟一轮；不去重会一直弹同一个版本。
        assert!(!prompts.should_prompt(Some("0.2.6"), false));
        // 但更新的版本仍然提示。
        assert!(prompts.should_prompt(Some("0.2.7"), false));
    }

    #[test]
    fn deferring_suppresses_this_session_only() {
        let mut prompts = UpdatePrompts::default();
        prompts.defer(Some("0.2.6"));
        assert!(!prompts.should_prompt(Some("0.2.6"), false));

        // 「下次启动」= 新进程 = 新的 UpdatePrompts，只带持久化的 ignored。
        let next_launch = UpdatePrompts::with_ignored(prompts.ignored_version());
        assert!(next_launch.should_prompt(Some("0.2.6"), false));
    }

    #[test]
    fn the_ignored_version_persists_across_a_restart_but_prompted_does_not() {
        let mut prompts = UpdatePrompts::default();
        prompts.ignore(Some("0.2.5"));
        prompts.mark_prompted(Some("0.2.9"));

        let restored = UpdatePrompts::with_ignored(prompts.ignored_version());
        assert!(!restored.should_prompt(Some("0.2.5"), false));
        assert!(restored.should_prompt(Some("0.2.9"), false));
    }

    #[test]
    fn version_comparison_ignores_case_and_surrounding_whitespace() {
        let mut prompts = UpdatePrompts::default();
        prompts.ignore(Some("  0.2.5-Beta  "));
        assert!(!prompts.should_prompt(Some("0.2.5-beta"), false));
    }

    #[test]
    fn a_blank_version_never_prompts() {
        let prompts = UpdatePrompts::default();
        assert!(!prompts.should_prompt(None, true));
        assert!(!prompts.should_prompt(Some("   "), true));
    }

    #[test]
    fn cancellation_is_only_allowed_before_the_drain_commits() {
        assert!(InstallStage::Preflight.can_cancel());
        assert!(InstallStage::Downloading.can_cancel());
        // 提交排空之后 Agent 已拒绝写入，必须走完。
        assert!(!InstallStage::Draining.can_cancel());
        assert!(!InstallStage::StoppingAgent.can_cancel());
        assert!(!InstallStage::Installing.can_cancel());
    }

    #[test]
    fn every_stage_has_a_user_facing_message() {
        for stage in [
            InstallStage::Preflight,
            InstallStage::Downloading,
            InstallStage::Draining,
            InstallStage::StoppingAgent,
            InstallStage::Installing,
        ] {
            assert!(!stage.message().is_empty());
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_does_not_need_an_explicit_relaunch() {
        assert!(!needs_explicit_relaunch());
    }

    #[test]
    #[cfg(not(windows))]
    fn macos_and_linux_need_an_explicit_relaunch() {
        assert!(needs_explicit_relaunch());
    }
}
