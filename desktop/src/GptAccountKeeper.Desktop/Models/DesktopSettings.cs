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

    public int? WindowX { get; init; }

    public int? WindowY { get; init; }

    public double WindowWidth { get; init; } = 1180;

    public double WindowHeight { get; init; } = 760;

    public bool WindowMaximized { get; init; }
}
