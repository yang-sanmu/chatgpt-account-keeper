// 发布构建不开控制台窗口。开发构建保留，用来看 Agent 启动和 IPC 的诊断输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    keeper_app_lib::run()
}
