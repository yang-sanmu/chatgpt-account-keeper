namespace GptAccountKeeper.Desktop.Infrastructure.Updates;

/// <summary>
/// 更新流程里与网络无关的那部分决策：哪个版本已经落盘、要不要弹窗、
/// 一条即将发布的状态是否会把"可安装"错误地降级。
///
/// 单独拆出来是为了能在没有 Velopack 安装上下文的情况下测试这些规则 ——
/// UpdateManager 需要真实的安装目录和发布源，测不到这里的状态机。
/// </summary>
internal sealed class UpdateGate
{
    private string? _ignoredVersion;
    /// <summary>本次会话已提示过的版本。“下次启动提醒”只压制到进程结束。</summary>
    private string? _promptedVersion;
    /// <summary>已下载完成、等待安装的版本。</summary>
    private string? _downloadedVersion;

    public string? IgnoredVersion => _ignoredVersion;

    public string? DownloadedVersion => _downloadedVersion;

    /// <summary>“忽略本次更新”：持久压制这一个版本，更高版本仍会提示。</summary>
    public void Ignore(string? version) => _ignoredVersion = Normalize(version);

    /// <summary>“下次启动提醒”：只压制本次会话。</summary>
    public void Defer(string? version) => _promptedVersion = Normalize(version);

    public void MarkPrompted(string? version) => _promptedVersion = Normalize(version);

    public void MarkDownloaded(string? version) => _downloadedVersion = Normalize(version);

    /// <summary>确认没有可用更新时才清空；否则会把待安装状态弄丢。</summary>
    public void ClearDownloaded() => _downloadedVersion = null;

    public bool IsDownloaded(string? version) =>
        Normalize(version) is { } normalized
        && string.Equals(normalized, _downloadedVersion, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 是否要弹窗。手动检查始终弹，否则用户点了“检查更新”界面上什么都不发生；
    /// 自动检查会跳过被忽略的版本和本次会话已提示过的版本。
    /// </summary>
    public bool ShouldPrompt(string? version, bool manual)
    {
        if (Normalize(version) is not { } normalized) return false;
        if (manual) return true;
        if (string.Equals(normalized, _ignoredVersion, StringComparison.OrdinalIgnoreCase)) return false;
        return !string.Equals(normalized, _promptedVersion, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 修正一条即将发布的状态，防止"已下载待安装"被降级成"需要再下载一次"。
    ///
    /// 这是 issue 3 的根因所在，有两条路径会踩到：
    /// 1. 下载完成后再检查一次更新，Velopack 仍报告该版本可用，旧代码无条件发布
    ///    available（CanDownload=true / CanInstall=false），"安全安装"随之变灰。
    /// 2. Velopack 的下载进度回调来自独立线程，最后一次可能在下载完成之后才投递，
    ///    把 downloaded 覆盖回 downloading。
    /// 两条都表现为"下载完还得再点一次下载才能安装"。
    /// </summary>
    public UpdateSnapshot Coalesce(UpdateSnapshot candidate)
    {
        if (candidate.CanInstall || _downloadedVersion is null) return candidate;
        // 说的就是这个版本：整条状态换成"已下载待安装"。
        if (IsDownloaded(candidate.Version)) return Downloaded(candidate.Version!);
        // 不带版本号的状态（checking / error）说的不是某个具体版本，
        // 不能顺手把"已下载待安装"抹掉 —— 否则每 6 小时一轮后台检查都会让
        // "安全安装"变灰，而一旦这轮检查因断网失败，按钮就再也回不来了。
        if (candidate.Version is null)
        {
            return candidate with
            {
                Version = _downloadedVersion,
                Progress = 100,
                CanInstall = true,
            };
        }
        // 版本号不同说明发现了更新的版本：那个版本确实还需要下载。
        return candidate;
    }

    public static UpdateSnapshot Downloaded(string version) => new(
        "downloaded",
        $"版本 {version} 已下载，等待安全安装",
        version,
        100,
        CanInstall: true);

    private static string? Normalize(string? version) =>
        string.IsNullOrWhiteSpace(version) ? null : version.Trim();
}
