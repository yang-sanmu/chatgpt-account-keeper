//! 路径解析与数据目录校验。
//!
//! 这里有两个必须分清的根：
//!
//! - **数据根**（`data_directory`）：用户数据。Profile、SQLite、状态缓存。
//! - **资源根**（由 Tauri 的 `resource_dir()` 提供）：随版本分发的只读资源，装在
//!   安装目录里。
//!
//! 混用它们在开发模式下完全正常（两者常常同盘相邻），装好后必坏，且报错通常指不到
//! 真正原因。这个项目已经踩过三次，见 docs/REFACTOR_STATUS.md 的 Alpha 6 段落。

use std::path::{Path, PathBuf};

const DEVELOPMENT_ENVIRONMENT_VARIABLE: &str = "GPTACCOUNTKEEPER_DEVELOPMENT";
const EXPLICIT_DATA_ROOT_VARIABLE: &str = "GPTACCOUNTKEEPER_DESKTOP_DATA_ROOT";

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("数据目录必须是绝对路径")]
    NotAbsolute,
    #[error("数据目录不能是文件系统根目录")]
    FilesystemRoot,
    #[error("不能把数据库和 Profile 放在网络共享")]
    NetworkShare,
    #[error("数据目录必须位于本地固定磁盘")]
    NotFixedDisk,
    #[error("数据目录不能与安装/程序目录重叠")]
    OverlapsInstallation,
    #[error("无法确定平台目录")]
    UnknownPlatformDirectory,
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub configuration_directory: PathBuf,
    pub settings_file: PathBuf,
    pub bootstrap_file: PathBuf,
    pub ipc_key_file: PathBuf,
    pub data_directory: PathBuf,
    pub database_file: PathBuf,
    pub cache_directory: PathBuf,
    pub state_directory: PathBuf,
    pub agent_log_file: PathBuf,
    pub migration_progress_file: PathBuf,
    pub is_development: bool,
    /// 是否允许从源码树解析 Agent、并使用 PATH 上的 node。见 `allows_source_agent()`。
    pub allows_source_agent: bool,
    /// 引导文件损坏时的告警。回落到默认目录，但必须让用户看到原因。
    pub bootstrap_warning: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct BootstrapPointer {
    version: u32,
    #[serde(rename = "dataRoot")]
    data_root: String,
}

/// 环境变量是否显式指定了开发模式。`None` 表示未指定，由调用方决定默认值。
fn development_override() -> Option<bool> {
    match std::env::var(DEVELOPMENT_ENVIRONMENT_VARIABLE).as_deref() {
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES") => Some(true),
        Ok("0") | Ok("false") | Ok("FALSE") | Ok("no") | Ok("NO") => Some(false),
        _ => None,
    }
}

/// 是否使用开发数据目录（`GptAccountKeeper-dev`）。
///
/// 顺序有讲究，三条都有具体理由：
///
/// 1. **环境变量最优先**，两个方向都支持。发布版设 `1` 可以跑一个隔离沙箱来验证首次
///    启动流程；调试版设 `0` 可以刻意接安装版数据。
/// 2. **release 构建**永远用生产目录。
/// 3. **debug 构建**优先用开发目录，但**只有当它已经建过库**。
///
/// 第 3 条的取舍：只看构建类型的话，一台已经有 42 个账号在生产目录的机器上，`tauri dev`
/// 会打开一个空的开发目录并停在欢迎页——想调试真实数据必须每次手设环境变量。反过来，
/// 无条件用生产目录则会让调试写坏日常在用的库。以「开发目录是否已初始化」作为判据，
/// 两种用法都能自然工作：想要隔离沙箱就先在开发目录里建一次库（或设环境变量），
/// 否则就接着用真实数据。
pub fn is_development() -> bool {
    if let Some(explicit) = development_override() {
        return explicit;
    }
    if !cfg!(debug_assertions) {
        return false;
    }
    development_data_root_initialized()
}

/// 开发数据目录里是否已经有数据库。
fn development_data_root_initialized() -> bool {
    match platform_roots(true) {
        Ok((_, data_root, _, _)) => data_root.join("keeper.db").is_file(),
        Err(_) => false,
    }
}

/// 是否允许从源码树解析 Agent 入口、并回落到 PATH 上的 node。
///
/// **这必须与 `is_development()` 分开判断。** 两者曾是同一个布尔值，而它们回答的是两个
/// 无关的问题：
///
/// - `is_development()`：用哪个**数据目录**。它以「开发数据目录是否已建库」为判据，
///   于是在只有生产数据的机器上返回 false —— 这是刻意的，为了让 `tauri dev` 能调真实数据。
/// - 这里：能不能用**源码树里的 Agent**。`cargo run` 出来的 exe 旁边不存在 `agent/runtime/node.exe`
///   （那是打包时才注入的资源），所以一个 debug 构建除了源码树没有别的 Agent 可用。
///
/// 合成一个布尔值的后果是真实的：上面那台机器上 `npm run tauri dev` 会以「发布模式」去
/// 解析 Agent，只找 `target/debug/agent/…`，找不到就 `CommandNotFound`，界面于是永远
/// 停在未连接，每个发起调用的页面各刷一串 `AGENT_NOT_CONNECTED`。
///
/// 判据是构建类型，不是数据目录：release 构建绝不碰源码树和 PATH 的 node（那等于让用户
/// 机器上任意 Node 版本参与运行），debug 构建则只有源码树可用。环境变量仍然优先，两个
/// 方向都支持。
pub fn allows_source_agent() -> bool {
    if let Some(explicit) = development_override() {
        return explicit;
    }
    cfg!(debug_assertions)
}

#[cfg(not(windows))]
fn home_directory() -> Result<PathBuf, PathError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(PathError::UnknownPlatformDirectory)
}

fn environment_directory(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// 平台默认的四个根。与 C# 版完全一致，因为已安装的数据就在这些位置。
fn platform_roots(development: bool) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), PathError> {
    let directory_name = if development {
        "GptAccountKeeper-dev"
    } else {
        "GptAccountKeeper"
    };

    #[cfg(windows)]
    {
        let appdata =
            environment_directory("APPDATA").ok_or(PathError::UnknownPlatformDirectory)?;
        let local =
            environment_directory("LOCALAPPDATA").ok_or(PathError::UnknownPlatformDirectory)?;
        let local_root = local.join(directory_name);
        Ok((
            appdata.join(directory_name),
            local_root.join("data"),
            local_root.join("cache"),
            local_root.join("state"),
        ))
    }

    #[cfg(target_os = "macos")]
    {
        let home = home_directory()?;
        let support = home
            .join("Library")
            .join("Application Support")
            .join(directory_name);
        Ok((
            support.clone(),
            support.clone(),
            home.join("Library").join("Caches").join(directory_name),
            support.join("state"),
        ))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = home_directory()?;
        let suffix = if development {
            "gpt-account-keeper-dev"
        } else {
            "gpt-account-keeper"
        };
        let configuration = environment_directory("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home.join(".config"))
            .join(suffix);
        let data = environment_directory("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join(suffix);
        let cache = environment_directory("XDG_CACHE_HOME")
            .unwrap_or_else(|| home.join(".cache"))
            .join(suffix);
        let state = environment_directory("XDG_STATE_HOME")
            .unwrap_or_else(|| home.join(".local").join("state"))
            .join(suffix);
        Ok((configuration, data, cache, state))
    }
}

impl AppPaths {
    pub fn resolve() -> Result<Self, PathError> {
        let development = is_development();
        let (configuration_root, default_data_root, cache_root, state_root) =
            platform_roots(development)?;
        let bootstrap_file = configuration_root.join("bootstrap.json");

        let mut data_root = default_data_root;
        let mut bootstrap_warning = None;

        if let Some(explicit) = environment_directory(EXPLICIT_DATA_ROOT_VARIABLE) {
            // 显式环境变量优先，且必须合法——用它来做诊断时静默回落最容易误判。
            data_root = validate_data_root(&explicit)?;
        } else if bootstrap_file.exists() {
            match read_bootstrap(&bootstrap_file) {
                Ok(configured) => data_root = configured,
                Err(message) => {
                    bootstrap_warning =
                        Some(format!("数据目录引导配置无效，已使用默认目录：{message}"));
                }
            }
        }

        Ok(Self {
            settings_file: configuration_root.join("desktop.json"),
            ipc_key_file: configuration_root.join("ipc.key"),
            bootstrap_file,
            database_file: data_root.join("keeper.db"),
            agent_log_file: state_root.join("agent.log"),
            migration_progress_file: state_root.join("migration-progress.json"),
            configuration_directory: configuration_root,
            data_directory: data_root,
            cache_directory: cache_root,
            state_directory: state_root,
            is_development: development,
            allows_source_agent: allows_source_agent(),
            bootstrap_warning,
        })
    }

    /// 数据目录是否已经初始化过。**不代表**后台还有 Agent 在跑。
    pub fn data_directory_initialized(&self) -> bool {
        self.database_file.exists()
    }
}

fn read_bootstrap(file: &Path) -> Result<PathBuf, String> {
    let text = std::fs::read_to_string(file).map_err(|error| error.to_string())?;
    let pointer: BootstrapPointer =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;
    if pointer.version != 1 {
        return Err(format!("bootstrap.json 版本不是 1：{}", pointer.version));
    }
    if pointer.data_root.trim().is_empty() {
        return Err("bootstrap.json 缺少 dataRoot".to_string());
    }
    validate_data_root(Path::new(&pointer.data_root)).map_err(|error| error.to_string())
}

/// 数据目录校验。这里会写 GB 级 Profile 和 SQLite，选错很贵。
pub fn validate_data_root(candidate: &Path) -> Result<PathBuf, PathError> {
    if !candidate.is_absolute() {
        return Err(PathError::NotAbsolute);
    }
    let full = normalize(candidate);

    if full.parent().is_none() {
        return Err(PathError::FilesystemRoot);
    }

    #[cfg(windows)]
    {
        let text = full.to_string_lossy();
        // UNC 路径：SQLite 的 WAL 在网络共享上不可靠，Chrome Profile 更是。
        if text.starts_with(r"\\") {
            return Err(PathError::NetworkShare);
        }
        // 盘符根（C:\）也算文件系统根。
        if text.len() <= 3 && text.contains(':') {
            return Err(PathError::FilesystemRoot);
        }
    }

    Ok(full)
}

/// 数据目录不能与安装目录重叠。
///
/// 单独一步而不是并进 `validate_data_root`：`resolve()` 在 Tauri 初始化之前跑，那时
/// 还拿不到安装目录。NSIS 的 currentUser 模式装在 `%LOCALAPPDATA%\<产品名>`，而数据
/// 在 `%LOCALAPPDATA%\GptAccountKeeper\data`，两者相邻但不重叠——这正是必须真的做
/// 这个检查而不是靠"它们看起来不一样"的原因。
pub fn assert_not_inside_installation(
    data_root: &Path,
    installation_root: &Path,
) -> Result<(), PathError> {
    let data = normalize(data_root);
    let install = normalize(installation_root);
    if contains(&data, &install) || contains(&install, &data) {
        return Err(PathError::OverlapsInstallation);
    }
    Ok(())
}

fn contains(candidate: &Path, parent: &Path) -> bool {
    let candidate_key = comparison_key(candidate);
    let parent_key = comparison_key(parent);
    if candidate_key == parent_key {
        return true;
    }
    // 前缀比较必须按路径分量，否则 `.../keeper-data` 会被判成在 `.../keeper` 之内。
    let mut prefix = parent_key.clone();
    prefix.push(std::path::MAIN_SEPARATOR);
    candidate_key.starts_with(&prefix)
}

fn comparison_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(std::path::MAIN_SEPARATOR);
    if cfg!(windows) {
        trimmed.to_uppercase()
    } else {
        trimmed.to_string()
    }
}

/// 绝对化并折叠 `.` / `..`，但不解析符号链接。
///
/// 不用 `canonicalize`：数据目录在首次运行时还不存在，而它必须先算出来才能创建。
/// Windows 上 `canonicalize` 还会返回 `\\?\` 前缀，混进用户可见的路径里很难看。
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 环境变量是进程全局的，而 cargo 在同一进程里并发跑测试。没有这把锁，一个用例
    /// 设 `=1` 的瞬间另一个正好读它，两边都会随机失败，而失败信息指向被读的那个断言。
    static ENVIRONMENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_environment() -> std::sync::MutexGuard<'static, ()> {
        // 中毒只说明另一个用例 panic 过；这把锁不保护任何不变量，继续用就行。
        ENVIRONMENT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    fn a_debug_build_uses_the_development_directory_only_when_it_has_data() {
        // 两个都要成立，否则会各自造成一种坏体验：
        // - 无条件用生产目录：调试会写坏日常在用的库。
        // - 无条件用开发目录：一台已有 42 个账号的机器上 `tauri dev` 停在欢迎页。
        let _guard = lock_environment();
        std::env::remove_var(DEVELOPMENT_ENVIRONMENT_VARIABLE);
        let has_dev_data = development_data_root_initialized();
        assert_eq!(
            is_development(),
            cfg!(debug_assertions) && has_dev_data,
            "未设环境变量时应看构建类型 + 开发目录是否已建库"
        );
    }

    #[test]
    fn a_debug_build_may_use_the_source_agent_even_when_it_uses_production_data() {
        // 回归测试。这两个判断曾是同一个布尔值，而它们回答的是两个无关的问题。
        //
        // 一台只有生产数据的机器上 is_development() 为 false（刻意的：让 tauri dev 能调
        // 真实数据），如果 Agent 解析也跟着它，debug 构建就会去找 target/debug/agent/…
        // 里根本不存在的随包 Agent，CommandNotFound，界面永远未连接，每个页面各刷一串
        // AGENT_NOT_CONNECTED。
        let _guard = lock_environment();
        std::env::remove_var(DEVELOPMENT_ENVIRONMENT_VARIABLE);
        assert_eq!(
            allows_source_agent(),
            cfg!(debug_assertions),
            "源码 Agent 的可用性只取决于构建类型，与数据目录无关"
        );
        if cfg!(debug_assertions) && !development_data_root_initialized() {
            assert!(!is_development(), "前提不成立：开发数据目录竟然已建库");
            assert!(
                allows_source_agent(),
                "debug 构建即使用生产数据目录，也必须仍能解析源码树里的 Agent"
            );
        }
    }

    #[test]
    fn a_release_build_never_allows_the_source_agent() {
        // 发布路径上用源码树的 Agent 或 PATH 的 node 等于让任意 Node 版本参与运行。
        let _guard = lock_environment();
        std::env::remove_var(DEVELOPMENT_ENVIRONMENT_VARIABLE);
        if !cfg!(debug_assertions) {
            assert!(!allows_source_agent());
        }
    }

    #[test]
    fn the_environment_variable_also_overrides_source_agent_resolution_in_both_directions() {
        let _guard = lock_environment();
        std::env::set_var(DEVELOPMENT_ENVIRONMENT_VARIABLE, "0");
        assert!(!allows_source_agent());
        std::env::set_var(DEVELOPMENT_ENVIRONMENT_VARIABLE, "1");
        assert!(allows_source_agent());
        std::env::remove_var(DEVELOPMENT_ENVIRONMENT_VARIABLE);
    }

    #[test]
    fn a_release_build_never_uses_the_development_directory_by_default() {
        let _guard = lock_environment();
        std::env::remove_var(DEVELOPMENT_ENVIRONMENT_VARIABLE);
        if !cfg!(debug_assertions) {
            assert!(!is_development());
        }
    }

    #[test]
    fn the_environment_variable_overrides_the_build_type_in_both_directions() {
        // 两个方向都要能覆盖：调试时接安装版数据用来复现只在真实数据上出现的问题，
        // 发布版跑沙箱用来验证首次启动流程。
        let _guard = lock_environment();
        std::env::set_var(DEVELOPMENT_ENVIRONMENT_VARIABLE, "0");
        assert!(!is_development());
        std::env::set_var(DEVELOPMENT_ENVIRONMENT_VARIABLE, "1");
        assert!(is_development());
        std::env::remove_var(DEVELOPMENT_ENVIRONMENT_VARIABLE);
    }

    #[test]
    fn development_and_production_never_share_a_data_directory() {
        // 两个模式必须落在不同目录，否则「隔离的开发数据」这个前提不成立。
        let (dev_config, dev_data, dev_cache, dev_state) = platform_roots(true).unwrap();
        let (prod_config, prod_data, prod_cache, prod_state) = platform_roots(false).unwrap();
        assert_ne!(dev_data, prod_data);
        assert_ne!(dev_config, prod_config);
        assert_ne!(dev_cache, prod_cache);
        assert_ne!(dev_state, prod_state);
    }

    #[test]
    fn a_relative_data_root_is_rejected() {
        assert!(matches!(
            validate_data_root(Path::new("keeper-data")),
            Err(PathError::NotAbsolute)
        ));
    }

    #[test]
    #[cfg(windows)]
    fn a_drive_root_is_rejected() {
        assert!(matches!(
            validate_data_root(Path::new(r"C:\")),
            Err(PathError::FilesystemRoot)
        ));
    }

    #[test]
    #[cfg(windows)]
    fn a_unc_path_is_rejected() {
        assert!(matches!(
            validate_data_root(Path::new(r"\\server\share\keeper")),
            Err(PathError::NetworkShare)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn the_filesystem_root_is_rejected() {
        assert!(matches!(
            validate_data_root(Path::new("/")),
            Err(PathError::FilesystemRoot)
        ));
    }

    #[test]
    fn a_normal_absolute_path_is_accepted() {
        let path = if cfg!(windows) {
            r"C:\Users\Test\AppData\Local\GptAccountKeeper\data"
        } else {
            "/home/test/.local/share/gpt-account-keeper"
        };
        assert_eq!(
            validate_data_root(Path::new(path)).unwrap(),
            normalize(Path::new(path))
        );
    }

    #[test]
    fn dot_segments_are_folded() {
        let path = if cfg!(windows) {
            r"C:\data\.\keeper\..\keeper\data"
        } else {
            "/data/./keeper/../keeper/data"
        };
        let expected = if cfg!(windows) {
            r"C:\data\keeper\data"
        } else {
            "/data/keeper/data"
        };
        assert_eq!(
            validate_data_root(Path::new(path)).unwrap(),
            PathBuf::from(expected)
        );
    }

    #[test]
    fn a_data_root_inside_the_installation_is_rejected() {
        let (install, data) = if cfg!(windows) {
            (r"C:\Program Files\Keeper", r"C:\Program Files\Keeper\data")
        } else {
            ("/opt/keeper", "/opt/keeper/data")
        };
        assert!(matches!(
            assert_not_inside_installation(Path::new(data), Path::new(install)),
            Err(PathError::OverlapsInstallation)
        ));
    }

    #[test]
    fn an_installation_inside_the_data_root_is_also_rejected() {
        let (install, data) = if cfg!(windows) {
            (r"C:\data\keeper\app", r"C:\data\keeper")
        } else {
            ("/data/keeper/app", "/data/keeper")
        };
        assert!(matches!(
            assert_not_inside_installation(Path::new(data), Path::new(install)),
            Err(PathError::OverlapsInstallation)
        ));
    }

    #[test]
    fn the_nsis_current_user_layout_passes_the_overlap_check() {
        // M1 门禁第 3 条。NSIS currentUser 装到 %LOCALAPPDATA%\<产品名>，数据在
        // %LOCALAPPDATA%\GptAccountKeeper\data：相邻但不重叠。这类问题只在装好之后
        // 可见，所以必须用真实的默认布局断言，而不是随便两个不同的路径。
        let (install, data) = if cfg!(windows) {
            (
                r"C:\Users\Test\AppData\Local\ChatGPT Account Keeper",
                r"C:\Users\Test\AppData\Local\GptAccountKeeper\data",
            )
        } else {
            (
                "/home/test/.local/lib/gpt-account-keeper",
                "/home/test/.local/share/gpt-account-keeper",
            )
        };
        assert_not_inside_installation(Path::new(data), Path::new(install)).unwrap();
    }

    #[test]
    fn a_sibling_directory_sharing_a_name_prefix_is_not_treated_as_nested() {
        // 字符串前缀比较会把 keeper-data 判成在 keeper 之内，导致合法目录被拒。
        let (install, data) = if cfg!(windows) {
            (r"C:\apps\keeper", r"C:\apps\keeper-data")
        } else {
            ("/apps/keeper", "/apps/keeper-data")
        };
        assert_not_inside_installation(Path::new(data), Path::new(install)).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn the_overlap_check_ignores_case_on_windows() {
        assert!(matches!(
            assert_not_inside_installation(
                Path::new(r"c:\program files\keeper\data"),
                Path::new(r"C:\Program Files\Keeper")
            ),
            Err(PathError::OverlapsInstallation)
        ));
    }

    #[test]
    fn a_bootstrap_pointer_with_the_wrong_version_is_reported_not_silently_used() {
        let root = std::env::temp_dir().join(format!("keeper-bootstrap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("bootstrap.json");
        std::fs::write(&file, r#"{"version":2,"dataRoot":"/tmp/x"}"#).unwrap();
        let error = read_bootstrap(&file).unwrap_err();
        assert!(error.contains("版本不是 1"), "{error}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_bootstrap_pointer_to_a_relative_path_is_rejected() {
        let root = std::env::temp_dir().join(format!("keeper-bootstrap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("bootstrap.json");
        std::fs::write(&file, r#"{"version":1,"dataRoot":"relative/path"}"#).unwrap();
        assert!(read_bootstrap(&file).is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
