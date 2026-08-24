//! 定位随包分发的 Agent 与私有 Node。
//!
//! 这些是**资源根**里的东西（安装目录），不是数据根。混用两个根在开发模式下完全正常
//! 而装好后必坏——见 paths.rs 顶部的说明。

use std::path::{Path, PathBuf};

/// 去掉 Windows 的 verbatim 路径前缀（`\\?\`）。
///
/// **这不是美化输出，是一个真实的启动失败。** `Path::canonicalize()` 在 Windows 上返回
/// `\\?\E:\GptAccount` 这种形式，而 Node 的 ESM 加载器对它调 `realpathSync` 会炸：
/// `EISDIR: illegal operation on a directory, lstat 'E:'`。Agent 于是在写出任何日志之前
/// 就退出，而 Launcher 用 CREATE_NO_WINDOW 且不重定向句柄，症状只表现为「IPC 尚未就绪」
/// 一直到超时 —— 指不到真正原因。
///
/// 任何进入 Agent 命令行或工作目录的路径都必须经过这里。
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        // 用 Components 判别而不是比较字符串前缀：字符串写法在源码里极易被工具链
        // 折叠成 `\?\`（本项目已经踩过），而 Prefix::Verbatim* 是类型级的判别。
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            match prefix.kind() {
                Prefix::VerbatimDisk(letter) => {
                    let mut rebuilt = PathBuf::from(format!("{}:\\", letter as char));
                    // 跳过紧随其后的 RootDir，剩下的原样拼回。
                    for component in components {
                        if !matches!(component, Component::RootDir) {
                            rebuilt.push(component.as_os_str());
                        }
                    }
                    return rebuilt;
                }
                Prefix::VerbatimUNC(server, share) => {
                    let mut rebuilt = PathBuf::from("\\\\");
                    rebuilt.push(server);
                    rebuilt.push(share);
                    for component in components {
                        if !matches!(component, Component::RootDir) {
                            rebuilt.push(component.as_os_str());
                        }
                    }
                    return rebuilt;
                }
                _ => {}
            }
        }
    }
    path.to_path_buf()
}

const EXECUTABLE_ENVIRONMENT_VARIABLE: &str = "GPTACCOUNTKEEPER_AGENT_EXECUTABLE";
const NODE_ENVIRONMENT_VARIABLE: &str = "GPTACCOUNTKEEPER_AGENT_NODE";
const ENTRY_ENVIRONMENT_VARIABLE: &str = "GPTACCOUNTKEEPER_AGENT_ENTRY";

#[derive(Debug, Clone)]
pub struct AgentCommand {
    /// 要执行的程序：私有 Node，或一个自包含的 Agent 可执行文件。
    pub program: PathBuf,
    pub working_directory: PathBuf,
    /// 放在用户参数之前的参数（Node 的入口脚本路径）。
    pub prefix_arguments: Vec<std::ffi::OsString>,
    pub is_node: bool,
}

fn node_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn environment_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// 找随包的私有 Node。
///
/// 只看资源目录，不看 PATH：发布路径上回落到 PATH 的 `node` 会让用户机器上装的
/// 任意 Node 版本参与运行，而 Agent 只在钉住的版本上验证过。
fn find_bundled_node(resource_root: &Path) -> Option<PathBuf> {
    [
        resource_root
            .join("agent")
            .join("runtime")
            .join(node_executable_name()),
        resource_root.join("runtime").join(node_executable_name()),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn find_agent_entry(resource_root: &Path, allow_development_search: bool) -> Option<PathBuf> {
    let direct = [
        resource_root
            .join("agent")
            .join("src")
            .join("agent")
            .join("launcher.js"),
        resource_root.join("agent").join("launcher.js"),
        resource_root.join("src").join("agent").join("launcher.js"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file());
    if direct.is_some() {
        return direct;
    }
    if !allow_development_search {
        return None;
    }

    // 开发模式：从资源目录和当前目录逐级上找仓库里的 src/agent/launcher.js。
    // 只在开发模式做，发布包里找不到就是找不到。
    for start in [resource_root.to_path_buf(), std::env::current_dir().ok()?] {
        let mut directory = Some(start.as_path());
        let mut depth = 0;
        while let Some(current) = directory {
            if depth >= 10 {
                break;
            }
            let candidate = current.join("src").join("agent").join("launcher.js");
            if candidate.is_file() {
                return Some(candidate);
            }
            directory = current.parent();
            depth += 1;
        }
    }
    None
}

/// 解析要执行的命令。
pub fn resolve_command(resource_root: &Path, is_development: bool) -> Option<AgentCommand> {
    if let Some(executable) = environment_path(EXECUTABLE_ENVIRONMENT_VARIABLE) {
        let working_directory = executable
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        return Some(AgentCommand {
            program: executable,
            working_directory,
            prefix_arguments: vec![],
            is_node: false,
        });
    }

    let entry = environment_path(ENTRY_ENVIRONMENT_VARIABLE)
        .or_else(|| find_agent_entry(resource_root, is_development))?;
    if !entry.is_file() {
        return None;
    }
    // Node 的 ESM 加载器不接受 verbatim 前缀，见 strip_verbatim_prefix 的说明。
    let entry = strip_verbatim_prefix(&entry);

    let node = environment_path(NODE_ENVIRONMENT_VARIABLE)
        .or_else(|| find_bundled_node(resource_root))
        .or_else(|| {
            // 开发模式下才允许 PATH 上的 node。
            is_development.then(|| PathBuf::from(node_executable_name()))
        })?;

    Some(AgentCommand {
        working_directory: entry.parent().map(Path::to_path_buf).unwrap_or_default(),
        prefix_arguments: vec![entry.clone().into_os_string()],
        program: strip_verbatim_prefix(&node),
        is_node: true,
    })
}

/// 迁移预检脚本，与 Agent 入口同目录。
pub fn find_migration_probe(command: &AgentCommand) -> Option<PathBuf> {
    if !command.is_node {
        return None;
    }
    let entry = PathBuf::from(command.prefix_arguments.first()?);
    let candidate = entry.parent()?.join("migrationProbe.js");
    candidate.is_file().then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("keeper-res-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"// test").unwrap();
    }

    #[test]
    fn a_packaged_layout_resolves_the_private_node_and_entry() {
        let root = temporary_root();
        // 逐段 join，与被测代码一致：`join("a/b")` 会原样保留正斜杠，在 Windows 上
        // 指向同一个文件但字符串不同，比较会假失败。
        let entry = root
            .join("agent")
            .join("src")
            .join("agent")
            .join("launcher.js");
        let node = root
            .join("agent")
            .join("runtime")
            .join(node_executable_name());
        touch(&entry);
        touch(&node);

        let command = resolve_command(&root, false).expect("应能解析随包布局");
        assert!(command.is_node);
        assert_eq!(command.program, node);
        assert_eq!(
            command.prefix_arguments,
            vec![entry.clone().into_os_string()]
        );
        assert_eq!(command.working_directory, entry.parent().unwrap());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn production_never_falls_back_to_path_node() {
        // 这条对应 C# 侧的 ProductionLauncherDoesNotUseSourceAgentOrPathNode。
        // 发布路径上用 PATH 的 node 等于让任意用户装的 Node 版本参与运行。
        let root = temporary_root();
        touch(&root.join("agent/src/agent/launcher.js"));
        assert!(
            resolve_command(&root, false).is_none(),
            "缺少私有 Node 时发布模式必须失败"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn production_never_searches_upwards_for_a_source_agent() {
        let root = temporary_root();
        // 父目录里有一个源码树，发布模式绝不能捡它。
        touch(&root.join("src/agent/launcher.js"));
        let nested = root.join("install");
        std::fs::create_dir_all(&nested).unwrap();
        touch(&nested.join("agent/runtime").join(node_executable_name()));

        assert!(resolve_command(&nested, false).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn development_may_search_upwards_and_use_path_node() {
        let root = temporary_root();
        let entry = root.join("src").join("agent").join("launcher.js");
        touch(&entry);
        let nested = root
            .join("app")
            .join("src-tauri")
            .join("target")
            .join("debug");
        std::fs::create_dir_all(&nested).unwrap();

        let command = resolve_command(&nested, true).expect("开发模式应能向上找到源码 Agent");
        assert_eq!(command.prefix_arguments, vec![entry.into_os_string()]);
        assert_eq!(command.program, PathBuf::from(node_executable_name()));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_migration_probe_is_found_next_to_the_entry() {
        let root = temporary_root();
        let entry = root
            .join("agent")
            .join("src")
            .join("agent")
            .join("launcher.js");
        touch(&entry);
        touch(
            &root
                .join("agent")
                .join("runtime")
                .join(node_executable_name()),
        );

        let command = resolve_command(&root, false).unwrap();
        assert!(find_migration_probe(&command).is_none());

        let probe = entry.parent().unwrap().join("migrationProbe.js");
        touch(&probe);
        assert_eq!(find_migration_probe(&command), Some(probe));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    #[cfg(windows)]
    fn a_verbatim_prefix_is_stripped_from_every_path_that_reaches_node() {
        // 回归测试。canonicalize() 返回 \\?\E:\... ，而 Node 的 ESM 加载器对它调
        // realpathSync 会报 EISDIR 并在写出任何日志之前退出。症状只表现为
        // 「IPC 尚未就绪」超时，完全指不到真正原因。
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\E:\GptAccount\src\agent\launcher.js")),
            PathBuf::from(r"E:\GptAccount\src\agent\launcher.js")
        );
        // UNC 形式要还原成 \\server\share，不能只把前缀切掉变成 UNC\server\share。
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\agent")),
            PathBuf::from(r"\\server\share\agent")
        );
        // 普通路径原样返回。
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"E:\GptAccount")),
            PathBuf::from(r"E:\GptAccount")
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_canonicalized_resource_root_still_yields_a_node_usable_command() {
        // 直接用 canonicalize 的输出当资源根 —— 这正是 S0-3 spike 最初的写法，
        // 它让 Agent 静默启动失败。命令里的每个路径都不能带 verbatim 前缀。
        let root = temporary_root();
        let entry = root
            .join("agent")
            .join("src")
            .join("agent")
            .join("launcher.js");
        touch(&entry);
        touch(
            &root
                .join("agent")
                .join("runtime")
                .join(node_executable_name()),
        );

        let canonical = root.canonicalize().unwrap();
        assert!(
            canonical.to_string_lossy().starts_with(r"\\?\"),
            "前提不成立：canonicalize 没有产生 verbatim 前缀"
        );

        let command = resolve_command(&canonical, false).expect("应能解析");
        assert!(
            !command.program.to_string_lossy().starts_with(r"\\?\"),
            "program 仍带 verbatim 前缀：{}",
            command.program.display()
        );
        for argument in &command.prefix_arguments {
            assert!(
                !argument.to_string_lossy().starts_with(r"\\?\"),
                "入口参数仍带 verbatim 前缀：{}",
                argument.to_string_lossy()
            );
        }
        assert!(
            !command
                .working_directory
                .to_string_lossy()
                .starts_with(r"\\?\"),
            "工作目录仍带 verbatim 前缀：{}",
            command.working_directory.display()
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_empty_environment_override_is_ignored_rather_than_used_as_a_path() {
        // 空字符串环境变量在 shell 脚本里很容易产生；当成路径会解析出当前目录。
        std::env::set_var(ENTRY_ENVIRONMENT_VARIABLE, "");
        assert!(environment_path(ENTRY_ENVIRONMENT_VARIABLE).is_none());
        std::env::remove_var(ENTRY_ENVIRONMENT_VARIABLE);
    }
}
