using System.Text.Json.Serialization;

namespace GptAccountKeeper.Desktop.Models;

internal sealed class LegacyMigrationCountsDto
{
    public int Accounts { get; init; }
    public int Profiles { get; init; }
    public int ArchivedProfiles { get; init; }
    public int Groups { get; init; }
    public int ConversationSets { get; init; }
    public int ProxyNodes { get; init; }
    public int Statuses { get; init; }
    public int Histories { get; init; }
    public int Rejects { get; init; }
}

internal sealed class LegacyProfileLockDto
{
    public string Collection { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string[] Files { get; init; } = [];
}

internal sealed class LegacyMigrationProbeResult
{
    public bool Ok { get; init; }
    public string SourceRoot { get; init; } = string.Empty;
    public bool SelectedProfilesDirectory { get; init; }
    public string SourceFingerprint { get; init; } = string.Empty;
    public LegacyMigrationCountsDto Counts { get; init; } = new();
    public long TotalProfileBytes { get; init; }
    public long RequiredBytes { get; init; }
    public long? AvailableBytes { get; init; }
    public bool? EnoughSpace { get; init; }
    public bool RequiresTrashDecision { get; init; }
    public LegacyProfileLockDto[] ActiveLocks { get; init; } = [];
    public LegacyMigrationProbeError? Error { get; init; }
}

internal sealed class LegacyMigrationProbeError
{
    public string Code { get; init; } = string.Empty;
    public string Message { get; init; } = string.Empty;
}

internal sealed class MigrationProgressDto
{
    public string State { get; init; } = "running";
    public string Stage { get; init; } = string.Empty;
    public string Message { get; init; } = string.Empty;
    public double? Progress { get; init; }
    public long? CopiedBytes { get; init; }
    public long? TotalBytes { get; init; }
    public int? CopiedProfiles { get; init; }
    public int? TotalProfiles { get; init; }
    public string? ProfileName { get; init; }
    public DateTimeOffset? OccurredAt { get; init; }
    public LegacyMigrationProbeError? Error { get; init; }
}
