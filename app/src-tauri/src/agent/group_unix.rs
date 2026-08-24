//! Unix：用进程组做进程树回收。
//!
//! **不声称与 Windows Job Object 同等保证。** Windows 的 `KILL_ON_JOB_CLOSE` 由内核在
//! 最后一个句柄关闭时执行，管理端被 SIGKILL 也照样生效；进程组只在我们还活着并能
//! 发出信号时有用。Windows 是首发平台，那里的兜底是硬的；这里是开发与次要平台路径。
//!
//! 与 Windows 版一致的一点：只按 PID / 进程组 ID 操作，从不按进程名做决定。

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};

#[derive(Debug, thiserror::Error)]
pub enum GroupError {
    #[error("创建 Agent 进程失败：{0}")]
    Spawn(#[from] std::io::Error),
}

pub struct GroupLaunch {
    pub process_id: u32,
    pub generation_id: i64,
    child: Child,
}

impl GroupLaunch {
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 向整个进程组发 SIGTERM，短暫等待后 SIGKILL。
    ///
    /// 负 PID 表示进程组。只有在 `process_group(0)` 成功建组之后才成立，所以这里的
    /// 进程组 ID 一定等于子进程 PID。
    pub fn reclaim(mut self) {
        let group = self.process_id as i32;
        unsafe {
            libc::kill(-group, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
        let _ = self.child.wait();
    }
}

pub struct LaunchRequest<'a> {
    pub program: &'a Path,
    pub arguments: Vec<std::ffi::OsString>,
    pub working_directory: Option<&'a Path>,
    pub environment: Vec<(String, String)>,
}

pub fn launch(request: LaunchRequest<'_>, generation_id: i64) -> Result<GroupLaunch, GroupError> {
    let mut command = Command::new(request.program);
    command.args(&request.arguments);
    if let Some(directory) = request.working_directory {
        command.current_dir(directory);
    }
    for (key, value) in &request.environment {
        command.env(key, value);
    }
    // 自成进程组：这样 kill(-pid) 能覆盖 Agent 拉起的所有后代，而不是只有它自己。
    command.process_group(0);

    let child = command.spawn()?;
    Ok(GroupLaunch {
        process_id: child.id(),
        generation_id,
        child,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_becomes_its_own_process_group_leader() {
        let mut launch = launch(
            LaunchRequest {
                program: Path::new("/bin/sh"),
                arguments: vec![
                    std::ffi::OsString::from("-c"),
                    std::ffi::OsString::from("sleep 30"),
                ],
                working_directory: None,
                environment: vec![],
            },
            1,
        )
        .unwrap();

        assert!(launch.is_running());
        // 进程组 ID 必须等于自身 PID，否则 kill(-pid) 会打到我们自己所在的组。
        let group = unsafe { libc::getpgid(launch.process_id as i32) };
        assert_eq!(group, launch.process_id as i32);
        launch.reclaim();
    }

    #[test]
    fn reclaiming_kills_a_grandchild_too() {
        let mut launch = launch(
            LaunchRequest {
                program: Path::new("/bin/sh"),
                arguments: vec![
                    std::ffi::OsString::from("-c"),
                    std::ffi::OsString::from(
                        "sleep 60 & echo $! > /tmp/keeper-grandchild.pid; sleep 60",
                    ),
                ],
                working_directory: None,
                environment: vec![],
            },
            1,
        )
        .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(300));
        let grandchild: i32 = std::fs::read_to_string("/tmp/keeper-grandchild.pid")
            .unwrap_or_default()
            .trim()
            .parse()
            .unwrap_or(0);
        assert!(grandchild > 0, "孙进程 PID 未写出");
        assert!(launch.is_running());
        launch.reclaim();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                let _ = std::fs::remove_file("/tmp/keeper-grandchild.pid");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = std::fs::remove_file("/tmp/keeper-grandchild.pid");
        panic!("回收后孙进程 {grandchild} 仍然存在");
    }
}
