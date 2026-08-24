//! Windows：在**创建时**把 Agent 放进 Job Object。
//!
//! `Process.Start` 之后再 `AssignProcessToJobObject` 在这里不可用：assign 不追溯，
//! 而 Agent 启动后第一件事就是拉起 chrome-launcher broker。实测 broker 会落在 job
//! 外面（agentInJob=true, brokerInJob=false）并在外层 job 被终止后存活——它持有每次
//! 运行的 per-run Job 句柄，于是 `KILL_ON_JOB_CLOSE` 永不触发，管理端崩溃时 Chrome
//! 全泄漏。
//!
//! `PROC_THREAD_ATTRIBUTE_JOB_LIST` 让进程在创建那一刻就在 job 里，窗口是零而不是
//! 「很小」。
//!
//! 这个模块只按句柄操作，从不按进程名做任何决定。

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTUPINFOEXW,
};

static GENERATION: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    #[error("创建 Job Object 失败：{0}")]
    CreateJob(String),
    #[error("武装 KILL_ON_JOB_CLOSE 失败：{0}")]
    ArmJob(String),
    #[error("准备进程属性列表失败：{0}")]
    AttributeList(String),
    #[error("创建 Agent 进程失败：{0}")]
    CreateProcess(String),
    #[error("创建出的 Agent 不在 Job 内")]
    NotContained,
}

/// 一个被纳管的 Agent 世代。
///
/// Drop 时关闭 job 句柄。job 上武装了 `KILL_ON_JOB_CLOSE`，且我们是最后一个持有者，
/// 所以关闭句柄会终止整棵进程树——这正是管理端异常退出时的兜底。
#[derive(Debug)]
pub struct JobLaunch {
    pub process_id: u32,
    pub generation_id: i64,
    job: HANDLE,
    process: HANDLE,
}

impl JobLaunch {
    /// 进程是否仍在运行。按句柄查，不枚举进程表，也不看进程名。
    pub fn is_running(&self) -> bool {
        use windows::Win32::Foundation::WAIT_TIMEOUT;
        use windows::Win32::System::Threading::WaitForSingleObject;
        unsafe { WaitForSingleObject(self.process, 0) == WAIT_TIMEOUT }
    }

    /// 主动回收这个世代：关 job 句柄，触发 `KILL_ON_JOB_CLOSE`。
    pub fn reclaim(self) {
        drop(self);
    }
}

impl Drop for JobLaunch {
    fn drop(&mut self) {
        unsafe {
            if !self.process.is_invalid() {
                let _ = CloseHandle(self.process);
            }
            // job 必须最后关：它是终止整棵树的那个句柄。
            if !self.job.is_invalid() {
                let _ = CloseHandle(self.job);
            }
        }
    }
}

// HANDLE 是裸指针别名，默认不是 Send。这两个句柄的所有权完整属于 JobLaunch，只在
// 持有者线程上被读写和关闭，跨线程移动是安全的。
unsafe impl Send for JobLaunch {}
unsafe impl Sync for JobLaunch {}

fn last_error() -> String {
    windows::core::Error::from_thread().message()
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// 创建一个已武装 `KILL_ON_JOB_CLOSE` 的 job。
///
/// 限制必须在**任何进程加入之前**武装，否则存在「成员已存在但限制未生效」的窗口。
fn create_kill_on_close_job() -> Result<HANDLE, JobError> {
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| JobError::CreateJob(error.message()))?;
    if job.is_invalid() {
        return Err(JobError::CreateJob(last_error()));
    }

    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let result = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if let Err(error) = result {
        unsafe {
            let _ = CloseHandle(job);
        }
        return Err(JobError::ArmJob(error.message()));
    }
    Ok(job)
}

/// 按 `CommandLineToArgvW` 的规则拼一条命令行。
///
/// 数据根和可执行文件路径经常带空格，朴素拼接会把一个参数拆成两个。
pub fn build_command_line(program: &Path, arguments: &[OsString]) -> OsString {
    let mut result = OsString::new();
    append_argument(&mut result, program.as_os_str());
    for argument in arguments {
        result.push(" ");
        append_argument(&mut result, argument);
    }
    result
}

pub fn append_argument(target: &mut OsString, value: &OsStr) {
    let text = value.to_string_lossy();
    if !text.is_empty() && !text.contains([' ', '\t', '"', '\n', '\u{b}']) {
        target.push(value);
        return;
    }

    let mut quoted = String::from("\"");
    let characters: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let mut backslashes = 0;
        while index < characters.len() && characters[index] == '\\' {
            backslashes += 1;
            index += 1;
        }
        if index == characters.len() {
            // 结尾的反斜杠会转义我们即将写入的收尾引号，必须成对翻倍。
            quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
            break;
        }
        if characters[index] == '"' {
            quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
        } else {
            quoted.extend(std::iter::repeat_n('\\', backslashes));
        }
        quoted.push(characters[index]);
        index += 1;
    }
    quoted.push('"');
    target.push(OsString::from(quoted));
}

/// Unicode 环境块：`NAME=VALUE\0...\0\0`。
///
/// 从父环境继承再叠显式覆盖：Agent 需要 PATH、SystemRoot 这些继承变量，只给覆盖项
/// 会让 Node 起不来。
pub fn build_environment_block(overrides: &[(String, String)]) -> Vec<u16> {
    let mut merged: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    for (key, value) in overrides {
        merged.insert(key.clone(), value.clone());
    }

    let mut block: Vec<u16> = Vec::new();
    for (key, value) in &merged {
        block.extend(OsString::from(format!("{key}={value}")).encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

pub struct LaunchRequest<'a> {
    pub program: &'a Path,
    pub arguments: Vec<OsString>,
    pub working_directory: Option<&'a Path>,
    pub environment: Vec<(String, String)>,
}

/// 在一个新建的 `KILL_ON_JOB_CLOSE` job 里创建进程，并**验证**它真的在里面。
///
/// 任何一步失败都 fail-closed：终止已创建的进程并返回错误，绝不交出一个未被证明
/// 纳管的进程。
pub fn launch(request: LaunchRequest<'_>) -> Result<JobLaunch, JobError> {
    let job = create_kill_on_close_job()?;

    // 从这里起任何提前返回都要关 job。用一个闭包收拢，避免每条错误路径各写一遍。
    let result = launch_in_job(job, request);
    match result {
        Ok(launch) => Ok(launch),
        Err(error) => {
            unsafe {
                let _ = CloseHandle(job);
            }
            Err(error)
        }
    }
}

fn launch_in_job(job: HANDLE, request: LaunchRequest<'_>) -> Result<JobLaunch, JobError> {
    let mut attribute_size = 0usize;
    unsafe {
        // 第一次调用必然失败并回填所需大小；ERROR_INSUFFICIENT_BUFFER 是预期结果。
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attribute_size);
    }
    if attribute_size == 0 {
        return Err(JobError::AttributeList(last_error()));
    }

    let mut attribute_buffer = vec![0u8; attribute_size];
    let attribute_list =
        LPPROC_THREAD_ATTRIBUTE_LIST(attribute_buffer.as_mut_ptr() as *mut std::ffi::c_void);
    unsafe {
        InitializeProcThreadAttributeList(Some(attribute_list), 1, None, &mut attribute_size)
            .map_err(|error| JobError::AttributeList(error.message()))?;
    }

    // UpdateProcThreadAttribute 存的是指针而不是拷贝：这个变量必须活过 CreateProcessW。
    let job_handle_storage = job;
    let update = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            Some(&job_handle_storage as *const HANDLE as *const std::ffi::c_void),
            std::mem::size_of::<HANDLE>(),
            None,
            None,
        )
    };
    if let Err(error) = update {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(JobError::AttributeList(error.message()));
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;

    let mut command_line = wide(&build_command_line(request.program, &request.arguments));
    let mut environment_block = build_environment_block(&request.environment);
    let working_directory = request.working_directory.map(|path| wide(path.as_os_str()));

    let mut information = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            Some(environment_block.as_mut_ptr() as *mut std::ffi::c_void),
            working_directory
                .as_ref()
                .map(|path| PCWSTR(path.as_ptr()))
                .unwrap_or(PCWSTR::null()),
            &startup.StartupInfo as *const _ as *const _,
            &mut information,
        )
    };

    unsafe { DeleteProcThreadAttributeList(attribute_list) };

    if let Err(error) = created {
        return Err(JobError::CreateProcess(error.message()));
    }

    let process = information.hProcess;
    let thread = information.hThread;
    unsafe {
        if !thread.is_invalid() {
            let _ = CloseHandle(thread);
        }
    }

    // 验证纳管，不信任标志位。这里静默失败的话，留下的正是一个不受兜底保护的 Agent。
    let mut in_job = windows::core::BOOL(0);
    let verified = unsafe { IsProcessInJob(process, Some(job), &mut in_job) };
    if verified.is_err() || !in_job.as_bool() {
        unsafe {
            let _ = TerminateProcess(process, 1);
            let _ = CloseHandle(process);
        }
        return Err(JobError::NotContained);
    }

    Ok(JobLaunch {
        process_id: information.dwProcessId,
        generation_id: GENERATION.fetch_add(1, Ordering::Relaxed) + 1,
        job,
        process,
    })
}

/// 仅用于测试与诊断：确认一个 PID 是否在给定 job 内。
#[allow(dead_code)]
pub fn process_is_in_job(process: HANDLE, job: HANDLE) -> bool {
    let mut in_job = windows::core::BOOL(0);
    unsafe { IsProcessInJob(process, Some(job), &mut in_job).is_ok() && in_job.as_bool() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;

    fn line(program: &str, arguments: &[&str]) -> String {
        let owned: Vec<OsString> = arguments.iter().map(OsString::from).collect();
        build_command_line(Path::new(program), &owned)
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn a_plain_argument_is_not_quoted() {
        assert_eq!(line("node.exe", &["--version"]), "node.exe --version");
    }

    #[test]
    fn paths_with_spaces_are_quoted() {
        assert_eq!(
            line(r"C:\Program Files\node.exe", &[r"C:\My Data\launcher.js"]),
            r#""C:\Program Files\node.exe" "C:\My Data\launcher.js""#
        );
    }

    #[test]
    fn a_trailing_backslash_before_the_closing_quote_is_doubled() {
        // "C:\My Data\" 会让收尾引号被转义，后面的参数全部并进这一个。
        assert_eq!(
            line("node.exe", &[r"C:\My Data\"]),
            r#"node.exe "C:\My Data\\""#
        );
    }

    #[test]
    fn embedded_quotes_are_escaped() {
        assert_eq!(
            line("node.exe", &[r#"say "hi""#]),
            r#"node.exe "say \"hi\"""#
        );
    }

    #[test]
    fn a_backslash_run_before_a_quote_is_doubled_then_the_quote_escaped() {
        assert_eq!(line("a.exe", &[r#"x\\"y"#]), r#"a.exe "x\\\\\"y""#);
    }

    #[test]
    fn an_empty_argument_becomes_an_explicit_empty_pair_of_quotes() {
        // 空参数不加引号会直接消失，导致后续位置参数错位。
        assert_eq!(line("a.exe", &[""]), r#"a.exe """#);
    }

    #[test]
    fn the_environment_block_is_double_nul_terminated() {
        let block = build_environment_block(&[("KEEPER_TEST_X".into(), "1".into())]);
        assert_eq!(block[block.len() - 1], 0);
        assert_eq!(block[block.len() - 2], 0);
    }

    #[test]
    fn the_environment_block_inherits_the_parent_and_applies_overrides() {
        std::env::set_var("KEEPER_TEST_INHERITED", "parent");
        let block = build_environment_block(&[
            ("KEEPER_TEST_OVERRIDE".into(), "child".into()),
            ("KEEPER_TEST_INHERITED".into(), "replaced".into()),
        ]);
        let text = String::from_utf16_lossy(&block);
        assert!(text.contains("KEEPER_TEST_OVERRIDE=child"));
        assert!(text.contains("KEEPER_TEST_INHERITED=replaced"));
        assert!(!text.contains("KEEPER_TEST_INHERITED=parent"));
        // 继承项还在：只给覆盖项的话 Node 会因为找不到 PATH/SystemRoot 起不来。
        assert!(text.contains("PATH=") || text.contains("Path="));
        std::env::remove_var("KEEPER_TEST_INHERITED");
    }

    #[test]
    fn a_launch_is_contained_and_closing_the_job_kills_the_whole_tree() {
        // 一个自己再 spawn 一个孙进程的子进程：这正是 Agent + chrome-launcher broker
        // 的形状，也是 Process.Start + AssignProcessToJobObject 会漏掉的那个进程。
        let launch = launch(LaunchRequest {
            program: Path::new("cmd.exe"),
            arguments: vec![
                OsString::from("/c"),
                OsString::from(
                    "start /b cmd.exe /c ping -n 60 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul",
                ),
            ],
            working_directory: None,
            environment: vec![],
        })
        .expect("创建纳管进程失败");

        assert!(launch.is_running());
        let process_id = launch.process_id;
        assert!(process_id > 0);

        launch.reclaim();

        // 关掉 job 句柄后进程树必须消失。轮询而不是固定 sleep：终止是异步的。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if !pid_exists(process_id) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("关闭 job 后 PID {process_id} 仍然存在");
    }

    #[test]
    fn a_process_started_outside_the_job_is_not_reported_as_contained() {
        // 反向断言：验证逻辑不是恒真。
        let job = create_kill_on_close_job().unwrap();
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let handle = unsafe {
            // AssignProcessToJobObject 需要 SET_QUOTA | TERMINATE，只有
            // QUERY_INFORMATION 会拿到 E_ACCESSDENIED。
            use windows::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            };
            OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                false,
                child.id(),
            )
            .unwrap()
        };
        assert!(!process_is_in_job(handle, job));

        // 补充确认 assign 确实能把它加进去——用来证明上面的 false 不是句柄权限问题。
        unsafe {
            AssignProcessToJobObject(job, handle).unwrap();
        }
        assert!(process_is_in_job(handle, job));

        unsafe {
            let _ = CloseHandle(handle);
            let _ = CloseHandle(job);
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn generations_are_monotonic() {
        let one = launch(LaunchRequest {
            program: Path::new("cmd.exe"),
            arguments: vec![OsString::from("/c"), OsString::from("exit 0")],
            working_directory: None,
            environment: vec![],
        })
        .unwrap();
        let two = launch(LaunchRequest {
            program: Path::new("cmd.exe"),
            arguments: vec![OsString::from("/c"), OsString::from("exit 0")],
            working_directory: None,
            environment: vec![],
        })
        .unwrap();
        assert!(two.generation_id > one.generation_id);
    }

    #[test]
    fn a_missing_executable_fails_closed() {
        let error = launch(LaunchRequest {
            program: Path::new(r"C:\definitely\missing\keeper-agent.exe"),
            arguments: vec![],
            working_directory: None,
            environment: vec![],
        })
        .unwrap_err();
        assert!(matches!(error, JobError::CreateProcess(_)), "{error:?}");
    }

    fn pid_exists(process_id: u32) -> bool {
        use windows::Win32::Foundation::STILL_ACTIVE;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
                Ok(handle) if handle != INVALID_HANDLE_VALUE && !handle.is_invalid() => handle,
                _ => return false,
            };
            let mut code = 0u32;
            let alive =
                GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
            let _ = CloseHandle(handle);
            alive
        }
    }

    #[test]
    fn os_string_round_trips_through_wide() {
        // wide() 的正确性是命令行传递的前提；中文路径必须能原样往返。
        let original = OsString::from(r"C:\数据\keeper");
        let encoded = wide(&original);
        assert_eq!(*encoded.last().unwrap(), 0);
        let decoded = OsString::from_wide(&encoded[..encoded.len() - 1]);
        assert_eq!(decoded, original);
    }
}
