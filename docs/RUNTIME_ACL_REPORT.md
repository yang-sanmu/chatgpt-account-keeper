# 运行目录权限只读报告

2026-10-14，M1-A。`acl-report` 检查本地 NTFS 目录的所有者和 DACL，不要求程序具有 Windows 代码签名，不修改权限，不执行目录内文件。

```powershell
dotnet publish tools/network-isolation/NetworkIsolation.csproj -c Release -r win-x64
$lab = (Resolve-Path tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe).Path
& $lab acl-report 'C:\NetworkLab\registered-runtime'
```

指定目录可以是 Chrome 副本或代理/Agent 的程序目录，不需要包含 `chrome.exe`。不要传入 Profile、凭据目录或整个卷。工具复用已有全文件扫描、硬链接/重解析点拒绝和变更检查，扫描目录内部所有文件及目录（包括空目录），并向上读取祖先直到卷根目录的 ACL。扫描后复核文件清单和安全描述符，发现变化或无法读取则失败，不输出部分成功报告；这些复核不是原子快照或启动锁。

输出 `runtime_acl_observation`，包含实际目录、观测完成时间，以及逐项 `path / scope / ownerSid / sddl / findings`。`scope` 区分内部文件、内部目录和祖先；`sddl` 保留所有者与原始 DACL，便于人工核查。报告只供本地诊断，含用户 SID 和本机路径，不直接上传。

当前按普通管理员安装布局检查：认可 SYSTEM、BUILTIN\Administrators 和 Windows TrustedInstaller 为维护主体。其它所有者记录 `owner_requires_review`；其它主体的写入、删除、修改 DACL/所有者授权记录 `write_grant_requires_review`。自定义服务 SID 尚无登记授权，本轮不提供任意可信 SID 白名单；未来服务身份需单独确认。

内部对象检查内容/元数据写入、增添子项、删除及权限修改；祖先侧检查删除自身/子项和修改权限的能力。仅能在祖先创建无关同级目录，不据此推定已有程序可被替换。依据是 Windows 的[文件访问权限](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)及[权限常量](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants)。

空 DACL 与缺失/null DACL 分别处理，后者记录 `unrestricted_dacl`；空 DACL 不含写入授权，但也不能据此证明程序可读取或执行。仅供继承的 ACE 不作用于当前对象，实际继承到各子对象的规则逐项检查，见 [ACE 继承规则](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-inheritance-rules)。GENERIC_WRITE/GENERIC_ALL 展开为文件权限；条件/对象等未支持 ACE 标为 `unsupported_ace`。

本工具不模拟 Windows 的令牌、组成员、特权、完整性级别及有效访问判断，也不从 allow 授权中直接减去 deny。含 deny 的布局可能仍被提示复核，这是报告的适用范围，不等于证明某个用户一定能写入。有待复核项时状态为 `review_required`，否则为 `no_obvious_write_grants`；后者也不表示通过完整权限验收或目录可用。

固定返回 `effectiveAccessChecked: false`、`aclModified: false`、`productionReady: false`、`launchAuthorization: not_issued`。本轮是独立观测命令，尚未作为输入接入 WFP 离线编译器或生产准入，因此现有 `signaturesAndAcl: not_checked` 不变。真实运行用户的读/执行权限、服务身份、检查后的更新锁和实际 WFP 隔离仍待验证。

验证包括：工具 `selftest` 中的合成安全描述符检查，以及 `node --test test/runtimeAcl.integration.test.js` 的实际 NTFS 文件测试。集成测试只在随机临时目录内设置两个 allow 授权作阳性对照，结束后删除夹具；检查命令本身不调用权限修改接口。测试覆盖 unsigned 合成文件、空目录、完整祖先、重复读取不变、文件写入/祖先删除子项授权、硬链接、junction 和不存在目录。
