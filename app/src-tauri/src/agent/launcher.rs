//! Agent 进程启动与世代管理。
//!
//! 「世代」是为了让迟到的退出观察不与下一次启动竞争：每次启动产生一个新世代，旧世代
//! 的句柄由它自己关闭。Windows 上关闭 job 句柄会触发 `KILL_ON_JOB_CLOSE`，跳过它会
//! 泄漏句柄，导致那个世代的遗留进程永不被回收。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use crate::ipc::endpoint::Endpoint;
use crate::paths::AppPaths;

use super::resources::{resolve_command, AgentCommand};

#[cfg(unix)]
use super::group_unix as backend;
#[cfg(windows)]
use super::job_windows as backend;

static GENERATION: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("找不到随应用安装的 Agent 或私有 Node。开发覆盖必须显式配置 Agent/Node 路径。")]
    CommandNotFound,
    #[error("启动 Agent 失败（无法在创建时纳入进程树兜底）：{0}")]
    Containment(String),
    #[error("启动 Agent 失败：{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
pub struct LaunchOutcome {
    pub process_id: u32,
    pub generation_id: i64,
    pub log_file: PathBuf,
    pub progress_file: PathBuf,
}

// 两个后端的句柄类型名不同，用一个别名统一，避免在 Launcher 里到处写 cfg。
#[cfg(windows)]
type Contained = backend::JobLaunch;
#[cfg(unix)]
type Contained = backend::GroupLaunch;

/// 当前世代。Windows 是 job 句柄的持有者，Unix 是进程组组长的子进程句柄。
pub struct Launcher {
    paths: AppPaths,
    resource_root: PathBuf,
    ipc_credential: String,
    current: Mutex<Option<Contained>>,
}

impl Launcher {
    pub fn new(paths: AppPaths, resource_root: PathBuf, ipc_credential: String) -> Self {
        Self {
            paths,
            resource_root,
            ipc_credential,
            current: Mutex::new(None),
        }
    }

    pub fn resource_root(&self) -> &Path {
        &self.resource_root
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    /// 传给 Agent 的环境变量。
    ///
    /// 这八个变量把 Agent 的四个根、IPC 凭据、进度文件和日志文件全部显式钉住。
    /// 不显式传的话 Agent 会自己按平台推断，开发模式下就会写进安装版的目录。
    pub fn environment(&self, endpoint: &Endpoint) -> Vec<(String, String)> {
        vec![
            (
                "GPTACCOUNTKEEPER_AGENT_ENDPOINT".into(),
                endpoint.address.clone(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_DATA_ROOT".into(),
                self.paths.data_directory.to_string_lossy().to_string(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_CACHE_ROOT".into(),
                self.paths.cache_directory.to_string_lossy().to_string(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_STATE_ROOT".into(),
                self.paths.state_directory.to_string_lossy().to_string(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_RUNTIME_ROOT".into(),
                self.paths
                    .cache_directory
                    .join("run")
                    .to_string_lossy()
                    .to_string(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_IPC_TOKEN".into(),
                self.ipc_credential.clone(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_MIGRATION_PROGRESS_FILE".into(),
                self.paths
                    .migration_progress_file
                    .to_string_lossy()
                    .to_string(),
            ),
            (
                "GPT_ACCOUNT_KEEPER_LOG_FILE".into(),
                self.paths.agent_log_file.to_string_lossy().to_string(),
            ),
        ]
    }

    /// 传给 Agent 的命令行参数。
    pub fn arguments(
        &self,
        command: &AgentCommand,
        endpoint: &Endpoint,
        legacy_root: Option<&Path>,
    ) -> Vec<OsString> {
        let mut arguments = command.prefix_arguments.clone();
        arguments.push(OsString::from("--endpoint"));
        arguments.push(OsString::from(&endpoint.address));
        arguments.push(OsString::from("--data-root"));
        arguments.push(self.paths.data_directory.clone().into_os_string());
        if let Some(legacy) = legacy_root {
            arguments.push(OsString::from("--legacy-root"));
            arguments.push(legacy.to_path_buf().into_os_string());
        }
        arguments
    }

    /// 启动一个新世代。
    ///
    /// 旧世代在新世代创建**之前**关闭：两个世代同时持有各自的 job 时，旧 Agent 仍在
    /// 后台对着同一个数据目录跑调度。
    pub fn start(
        &self,
        endpoint: &Endpoint,
        legacy_root: Option<&Path>,
    ) -> Result<LaunchOutcome, LaunchError> {
        // 用 allows_source_agent 而不是 is_development：后者回答的是「用哪个数据目录」，
        // 在只有生产数据的机器上为 false，会让 debug 构建按发布布局去找一个不存在的
        // 随包 Agent。见 paths::allows_source_agent 的说明。
        let command = resolve_command(&self.resource_root, self.paths.allows_source_agent)
            .ok_or(LaunchError::CommandNotFound)?;

        std::fs::create_dir_all(&self.paths.state_directory)?;
        if legacy_root.is_some() && self.paths.migration_progress_file.exists() {
            // 上一次迁移的进度记录会让新的一次立刻读到「已完成」。
            std::fs::remove_file(&self.paths.migration_progress_file)?;
        }

        let arguments = self.arguments(&command, endpoint, legacy_root);
        let environment = self.environment(endpoint);

        let mut current = self.current.lock().expect("世代锁被污染");
        *current = None;

        // Windows 的世代号由 job 启动本身分配；Unix 后端没有 job 概念，用这里的计数。
        #[cfg_attr(windows, allow(unused_variables))]
        let generation_id = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;

        #[cfg(windows)]
        let launch = backend::launch(backend::LaunchRequest {
            program: &command.program,
            arguments,
            working_directory: Some(&command.working_directory),
            environment,
        })
        .map_err(|error| LaunchError::Containment(error.to_string()))?;

        #[cfg(unix)]
        let launch = backend::launch(
            backend::LaunchRequest {
                program: &command.program,
                arguments,
                working_directory: Some(&command.working_directory),
                environment,
            },
            generation_id,
        )
        .map_err(|error| LaunchError::Containment(error.to_string()))?;

        let outcome = LaunchOutcome {
            process_id: launch.process_id,
            generation_id: launch.generation_id,
            log_file: self.paths.agent_log_file.clone(),
            progress_file: self.paths.migration_progress_file.clone(),
        };
        *current = Some(launch);
        Ok(outcome)
    }

    /// 当前世代的进程是否仍在运行。按句柄/PID 查，绝不按进程名。
    pub fn current_is_running(&self) -> bool {
        let mut current = self.current.lock().expect("世代锁被污染");
        match current.as_mut() {
            Some(launch) => launch.is_running(),
            None => false,
        }
    }

    /// 回收当前世代：Windows 关 job 触发 KILL_ON_JOB_CLOSE，Unix 向进程组发信号。
    pub fn reclaim_current(&self) {
        let mut current = self.current.lock().expect("世代锁被污染");
        if let Some(launch) = current.take() {
            launch.reclaim();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::endpoint::Transport;

    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            configuration_directory: root.join("config"),
            settings_file: root.join("config/desktop.json"),
            bootstrap_file: root.join("config/bootstrap.json"),
            ipc_key_file: root.join("config/ipc.key"),
            data_directory: root.join("data"),
            database_file: root.join("data/keeper.db"),
            cache_directory: root.join("cache"),
            state_directory: root.join("state"),
            agent_log_file: root.join("state/agent.log"),
            migration_progress_file: root.join("state/migration-progress.json"),
            is_development: false,
            allows_source_agent: false,
            bootstrap_warning: None,
        }
    }

    fn endpoint() -> Endpoint {
        Endpoint {
            transport: if cfg!(windows) {
                Transport::NamedPipe
            } else {
                Transport::UnixSocket
            },
            address: if cfg!(windows) {
                r"\\.\pipe\keeper-test".to_string()
            } else {
                "/tmp/keeper-test.sock".to_string()
            },
        }
    }

    fn temporary_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("keeper-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn the_environment_pins_all_four_roots_and_the_credential() {
        let root = temporary_root();
        let launcher = Launcher::new(test_paths(&root), root.clone(), "token-abc".into());
        let environment: std::collections::HashMap<String, String> =
            launcher.environment(&endpoint()).into_iter().collect();

        assert_eq!(
            environment["GPT_ACCOUNT_KEEPER_DATA_ROOT"],
            root.join("data").to_string_lossy()
        );
        assert_eq!(
            environment["GPT_ACCOUNT_KEEPER_CACHE_ROOT"],
            root.join("cache").to_string_lossy()
        );
        assert_eq!(
            environment["GPT_ACCOUNT_KEEPER_STATE_ROOT"],
            root.join("state").to_string_lossy()
        );
        // 运行时根在 cache 之下：它是可丢弃的，不能进数据目录。
        assert_eq!(
            environment["GPT_ACCOUNT_KEEPER_RUNTIME_ROOT"],
            root.join("cache").join("run").to_string_lossy()
        );
        assert_eq!(environment["GPT_ACCOUNT_KEEPER_IPC_TOKEN"], "token-abc");
        assert_eq!(environment.len(), 8);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_data_root_argument_is_passed_separately_from_the_environment() {
        // Agent 两个都读；只给环境变量的话，用 --data-root 的诊断启动路径会不一致。
        let root = temporary_root();
        let launcher = Launcher::new(test_paths(&root), root.clone(), "t".into());
        let command = AgentCommand {
            program: PathBuf::from("node"),
            working_directory: root.clone(),
            prefix_arguments: vec![OsString::from("launcher.js")],
            is_node: true,
        };
        let arguments = launcher.arguments(&command, &endpoint(), None);
        let text: Vec<String> = arguments
            .iter()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect();

        assert_eq!(text[0], "launcher.js");
        assert!(text.contains(&"--endpoint".to_string()));
        assert!(text.contains(&"--data-root".to_string()));
        assert!(!text.contains(&"--legacy-root".to_string()));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_legacy_import_adds_the_legacy_root_argument() {
        let root = temporary_root();
        let launcher = Launcher::new(test_paths(&root), root.clone(), "t".into());
        let command = AgentCommand {
            program: PathBuf::from("node"),
            working_directory: root.clone(),
            prefix_arguments: vec![],
            is_node: true,
        };
        let legacy = root.join("old-project");
        let arguments = launcher.arguments(&command, &endpoint(), Some(&legacy));
        let text: Vec<String> = arguments
            .iter()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect();
        assert!(text.contains(&"--legacy-root".to_string()));
        assert!(text.contains(&legacy.to_string_lossy().to_string()));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_agent_fails_closed_rather_than_starting_something_else() {
        let root = temporary_root();
        let launcher = Launcher::new(test_paths(&root), root.join("empty-install"), "t".into());
        let error = launcher.start(&endpoint(), None).unwrap_err();
        assert!(matches!(error, LaunchError::CommandNotFound), "{error:?}");
        assert!(!launcher.current_is_running());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reclaiming_without_a_current_generation_is_a_no_op() {
        let root = temporary_root();
        let launcher = Launcher::new(test_paths(&root), root.clone(), "t".into());
        launcher.reclaim_current();
        launcher.reclaim_current();
        assert!(!launcher.current_is_running());
        std::fs::remove_dir_all(&root).ok();
    }
}
