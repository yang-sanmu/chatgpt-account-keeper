using System.Text.Json.Serialization;

namespace GptAccountKeeper.Desktop.Models;

[JsonConverter(typeof(JsonStringEnumConverter<CloseBehavior>))]
internal enum CloseBehavior
{
    Ask,
    MinimizeToTray,
    ExitAll,
}

[JsonConverter(typeof(JsonStringEnumConverter<UpdatePolicy>))]
internal enum UpdatePolicy
{
    NotifyOnly,
    DownloadAndPrompt,
    InstallAtSafePoint,
}

internal sealed class DesktopSettings
{
    public CloseBehavior CloseBehavior { get; init; } = CloseBehavior.Ask;

    public bool StartAtLogin { get; init; }

    public UpdatePolicy UpdatePolicy { get; init; } = UpdatePolicy.NotifyOnly;

    /// <summary>
    /// 用户选择“忽略本次更新”的版本号。只压制这一个版本的弹窗，
    /// 更高的版本仍会照常提示；手动点“检查更新”也仍会重新提供该版本。
    /// </summary>
    public string? IgnoredUpdateVersion { get; init; }

    /// <summary>
    /// 待执行的旧项目导入源目录。
    ///
    /// 首次启动后再导入必须换一个空数据目录，而换目录要重启进程才能生效，
    /// 所以待导入的旧项目根目录要写在 desktop.json（它在配置目录，不随数据目录切换）。
    /// </summary>
    public string? PendingLegacyImportRoot { get; init; }

    public int? WindowX { get; init; }

    public int? WindowY { get; init; }

    public double WindowWidth { get; init; } = 1180;

    public double WindowHeight { get; init; } = 760;

    public bool WindowMaximized { get; init; }
}
