//! 单实例守卫，**按规范化数据目录分域**。
//!
//! 不用 `tauri-plugin-single-instance`：它的锁标识固定由 app identifier 派生
//! （`org.{id}.SingleInstance`），无法按数据目录分域。我们需要的语义是：
//!
//! - 不同数据目录可以同时各跑一个实例（开发模式与安装模式共存）。
//! - 同一数据目录的第二个实例只把已有窗口带到前台，然后自己退出。
//!
//! 第二条要求一个跨进程的激活信号，而不只是一把锁。

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::ipc::endpoint::canonical_data_root;

fn scope_hash(data_root: &Path) -> String {
    let digest = Sha256::digest(canonical_data_root(data_root).as_bytes());
    hex::encode(&digest[..8]).to_uppercase()
}

#[cfg(windows)]
mod platform {
    use super::scope_hash;
    use std::path::Path;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, SetEvent, EVENT_MODIFY_STATE,
    };

    pub struct Guard {
        mutex: HANDLE,
        activation: Option<HANDLE>,
    }

    // 两个句柄的所有权完整属于 Guard，只在持有者线程上关闭。
    unsafe impl Send for Guard {}
    unsafe impl Sync for Guard {}

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                if let Some(activation) = self.activation.take() {
                    let _ = CloseHandle(activation);
                }
                if !self.mutex.is_invalid() {
                    // 命名互斥量随最后一个句柄关闭而消失，不需要显式 release：
                    // 进程崩溃时内核也会做同样的事，两条路径行为一致。
                    let _ = CloseHandle(self.mutex);
                }
            }
        }
    }

    fn mutex_name(scope: &str) -> HSTRING {
        HSTRING::from(format!("Local\\GptAccountKeeper.Desktop.{scope}"))
    }

    fn activation_name(scope: &str) -> HSTRING {
        HSTRING::from(format!("Local\\GptAccountKeeper.Desktop.Activate.{scope}"))
    }

    /// 尝试成为这个数据目录的唯一实例。
    pub fn try_acquire(data_root: &Path) -> Option<Guard> {
        let scope = scope_hash(data_root);
        unsafe {
            let mutex = CreateMutexW(None, false, &mutex_name(&scope)).ok()?;
            // ERROR_ALREADY_EXISTS 说明另一个实例已经持有。立刻放弃而不是等待：
            // 等待会让第二次双击挂在后台而不是干脆退出。
            //
            // 直接读 GetLastError 而不是把 HRESULT 掩码回 Win32 码：掩码写法在
            // FACILITY 不是 WIN32 时会误判，而这里判错的后果是两个实例同时对着一个
            // SQLite 写。
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(mutex);
                return None;
            }
            let activation = CreateEventW(None, false, false, &activation_name(&scope)).ok();
            Some(Guard { mutex, activation })
        }
    }

    /// 通知同一数据目录的已有实例显示窗口。
    pub fn signal_existing(data_root: &Path) -> bool {
        let scope = scope_hash(data_root);
        unsafe {
            match OpenEventW(EVENT_MODIFY_STATE, false, &activation_name(&scope)) {
                Ok(handle) => {
                    let signalled = SetEvent(handle).is_ok();
                    let _ = CloseHandle(handle);
                    signalled
                }
                Err(_) => false,
            }
        }
    }

    impl Guard {
        /// 阻塞等待一次激活信号。调用方在后台线程里循环调用。
        pub fn wait_for_activation(&self) -> bool {
            use windows::Win32::Foundation::WAIT_OBJECT_0;
            use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
            let Some(activation) = self.activation else {
                return false;
            };
            unsafe { WaitForSingleObject(activation, INFINITE) == WAIT_OBJECT_0 }
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::scope_hash;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};

    /// Unix 上用一个 Unix socket 同时做锁和激活通道：bind 成功即持有，连上去写一个
    /// 字节就是激活信号。抽象套接字不可移植（macOS 没有），所以用文件系统路径。
    pub struct Guard {
        listener: UnixListener,
        path: PathBuf,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn socket_path(data_root: &Path) -> PathBuf {
        let scope = scope_hash(data_root);
        let runtime = std::env::var("XDG_RUNTIME_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    PathBuf::from("/tmp")
                } else {
                    std::env::temp_dir()
                }
            });
        runtime.join(format!("kpr-ui-{scope}.sock"))
    }

    pub fn try_acquire(data_root: &Path) -> Option<Guard> {
        let path = socket_path(data_root);
        match UnixListener::bind(&path) {
            Ok(listener) => Some(Guard { listener, path }),
            Err(_) => {
                // 已存在：可能是活着的实例，也可能是崩溃留下的陈旧文件。连一下就知道。
                if UnixStream::connect(&path).is_ok() {
                    return None;
                }
                let _ = std::fs::remove_file(&path);
                UnixListener::bind(&path)
                    .ok()
                    .map(|listener| Guard { listener, path })
            }
        }
    }

    pub fn signal_existing(data_root: &Path) -> bool {
        match UnixStream::connect(socket_path(data_root)) {
            Ok(mut stream) => stream.write_all(b"activate").is_ok(),
            Err(_) => false,
        }
    }

    impl Guard {
        pub fn wait_for_activation(&self) -> bool {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0u8; 8];
                    let _ = stream.read(&mut buffer);
                    true
                }
                Err(_) => false,
            }
        }
    }
}

pub use platform::{signal_existing, try_acquire, Guard};

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_root(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("keeper-instance-{}-{suffix}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn only_one_owner_per_data_directory() {
        let root = unique_root("a");
        let first = try_acquire(&root).expect("第一个实例应该拿到");
        // 同一数据目录的第二个实例必须被拒绝，否则两个 Agent 会对着同一个 SQLite 写。
        assert!(try_acquire(&root).is_none());
        drop(first);
        // 释放后可以重新获取：崩溃恢复靠的就是这条。
        assert!(try_acquire(&root).is_some());
    }

    #[test]
    fn different_data_directories_can_run_side_by_side() {
        // 开发模式与安装模式必须能同时开着。
        let one = unique_root("one");
        let two = unique_root("two");
        let first = try_acquire(&one).expect("第一个数据目录");
        let second = try_acquire(&two).expect("第二个数据目录应该也能拿到");
        drop(first);
        drop(second);
    }

    #[test]
    #[cfg(windows)]
    fn the_scope_hash_ignores_case_and_trailing_separators_on_windows() {
        assert_eq!(
            scope_hash(Path::new(r"C:\Data\Keeper\")),
            scope_hash(Path::new(r"c:\data\keeper"))
        );
    }

    #[test]
    fn the_activation_signal_is_scoped_to_the_data_directory() {
        let mine = unique_root("mine");
        let other = unique_root("other");
        let _guard = try_acquire(&mine).expect("拿到自己的域");

        // 向另一个数据目录发信号不该到达我们——否则并存的两个实例会互相把窗口拉到前台。
        assert!(!signal_existing(&other));
        // 向自己的域发信号应该成功。
        assert!(signal_existing(&mine));
    }

    #[test]
    fn signalling_a_directory_with_no_instance_reports_failure() {
        // 返回 false 是「没有已有实例」的判据：调用方据此决定自己继续启动。
        assert!(!signal_existing(&unique_root("empty")));
    }
}
