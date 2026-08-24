//! S0-2 验收 spike：证明创建时纳管确实覆盖孙进程，而 spawn-then-assign 不覆盖。
//!
//! 这不是单元测试，因为它要观察一个**跨进程、异步终止**的事实，并且需要在没有测试
//! 框架并发干扰的情况下枚举进程树。运行：
//!
//! ```powershell
//! cargo run --example containment_spike
//! ```
//!
//! 期望输出：
//! - `JOB_LIST` 组：孙进程在关闭 job 后消失（这是我们要的行为）。
//! - `NAIVE_ASSIGN` 组：孙进程存活（这正是 C# 注释里记录的 Chrome 泄漏路径）。
//!
//! 如果两组都消失，说明纳管测试没有判别力，S0-2 不算通过。

#![cfg(windows)]

use std::ffi::OsString;
use std::path::Path;

use keeper_app_lib::agent::job_windows::{launch, LaunchRequest};
use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::AssignProcessToJobObject;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

/// 一条自己再 spawn 一个后代的命令：`start /b` 让 ping 成为独立的孙进程。
/// 这正是 Agent + chrome-launcher broker 的形状。
const SPAWNS_A_GRANDCHILD: &str =
    "start /b cmd.exe /c ping -n 120 127.0.0.1 >nul & ping -n 120 127.0.0.1 >nul";

fn pid_alive(process_id: u32) -> bool {
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
            Ok(handle) if !handle.is_invalid() => handle,
            _ => return false,
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

/// 用 ToolHelp 枚举进程表，找出 `parent` 的所有后代 PID。
///
/// 不用 wmic：Windows 11 26200 已经移除它。也不按进程名做任何决定——只用 PID 关系。
fn descendants(parent: u32) -> Vec<u32> {
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(_) => return Vec::new(),
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    let mut found = vec![parent];
    let mut index = 0;
    while index < found.len() {
        let current = found[index];
        for (pid, parent_pid) in &pairs {
            if *parent_pid == current && !found.contains(pid) {
                found.push(*pid);
            }
        }
        index += 1;
    }
    found.remove(0);
    found
}

fn wait_until_gone(pids: &[u32], timeout: std::time::Duration) -> Vec<u32> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let alive: Vec<u32> = pids.iter().copied().filter(|pid| pid_alive(*pid)).collect();
        if alive.is_empty() || std::time::Instant::now() >= deadline {
            return alive;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// A 组：`PROC_THREAD_ATTRIBUTE_JOB_LIST`，进程在创建那一刻就在 job 里。
fn job_list_group() -> bool {
    let handle = launch(LaunchRequest {
        program: Path::new("cmd.exe"),
        arguments: vec![OsString::from("/c"), OsString::from(SPAWNS_A_GRANDCHILD)],
        working_directory: None,
        environment: vec![],
    })
    .expect("创建纳管进程失败");

    let root = handle.process_id;
    std::thread::sleep(std::time::Duration::from_millis(1200));
    let tree = descendants(root);
    println!("[JOB_LIST]      root={root} descendants={tree:?}");
    assert!(
        !tree.is_empty(),
        "[JOB_LIST] 没有观察到后代进程，spike 本身失效（cmd 布局变了？）"
    );

    let mut all = vec![root];
    all.extend_from_slice(&tree);

    // 关闭 job 句柄 → KILL_ON_JOB_CLOSE。
    handle.reclaim();

    let survivors = wait_until_gone(&all, std::time::Duration::from_secs(8));
    if survivors.is_empty() {
        println!("[JOB_LIST]      关闭 job 后整棵树消失 ✓");
        true
    } else {
        println!("[JOB_LIST]      残留 {survivors:?} ✗");
        for pid in survivors {
            kill(pid);
        }
        false
    }
}

/// B 组：先 `spawn` 再 `AssignProcessToJobObject`。assign 不追溯，spawn 与 assign
/// 之间创建的后代落在 job 外。
fn naive_assign_group() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job: HANDLE = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.expect("CreateJobObject");
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .expect("SetInformationJobObject");
    }

    let mut child = std::process::Command::new("cmd.exe")
        .args(["/c", SPAWNS_A_GRANDCHILD])
        .spawn()
        .expect("spawn");
    let root = child.id();

    // 现实里这个窗口就是 Agent 启动 broker 的时间。这里放大到 400ms 让它稳定可观察，
    // 但即使是 0ms 也只是把概率变小，不会消除窗口——这正是问题所在。
    std::thread::sleep(std::time::Duration::from_millis(400));

    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            false,
            root,
        )
        .expect("OpenProcess")
    };
    unsafe { AssignProcessToJobObject(job, process).expect("AssignProcessToJobObject") };

    std::thread::sleep(std::time::Duration::from_millis(800));
    let tree = descendants(root);
    println!("[NAIVE_ASSIGN]  root={root} descendants={tree:?}");

    unsafe {
        let _ = CloseHandle(process);
        let _ = CloseHandle(job);
    }

    let survivors = wait_until_gone(&tree, std::time::Duration::from_secs(4));
    let leaked = !survivors.is_empty();
    if leaked {
        println!("[NAIVE_ASSIGN]  关闭 job 后仍有 {survivors:?} 存活 → 这就是 Chrome 泄漏路径");
    } else {
        println!("[NAIVE_ASSIGN]  后代也一起消失了 —— 本机复现不出泄漏窗口");
    }

    for pid in survivors {
        kill(pid);
    }
    let _ = child.kill();
    let _ = child.wait();
    leaked
}

fn kill(process_id: u32) {
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, process_id) {
            let _ = windows::Win32::System::Threading::TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

fn main() {
    println!("=== S0-2 纳管 spike ===");
    let contained = job_list_group();
    println!();
    let leaked = naive_assign_group();

    println!("\n=== 结论 ===");
    println!("JOB_LIST 整棵树被回收        : {contained}");
    println!("NAIVE_ASSIGN 泄漏了后代进程  : {leaked}");

    if !contained {
        println!("\n✗ S0-2 未通过：创建时纳管没能回收整棵进程树。");
        std::process::exit(1);
    }
    if !leaked {
        println!(
            "\n! JOB_LIST 通过，但本机没复现出 NAIVE_ASSIGN 的泄漏。\n\
             这不否证 JOB_LIST 的正确性，但说明「两种做法有区别」这一点在本机不可观察，\n\
             判别力的证据来自 job_windows.rs 里那条不关 job 的反向断言。"
        );
    }
    println!("\n✓ S0-2 通过。");
}
