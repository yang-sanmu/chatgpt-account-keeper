using System.Text.Json;
using System.Text.Json.Serialization;

namespace GptAccountKeeper.ChromeLauncher;

// AOT requires a source-generated serializer context; reflection-based JSON is trimmed away.
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(BrokerRequest))]
[JsonSerializable(typeof(BrokerResponse))]
internal sealed partial class BrokerJson : JsonSerializerContext
{
}

internal sealed class BrokerRequest
{
    [JsonPropertyName("requestId")] public string? RequestId { get; set; }
    [JsonPropertyName("command")] public string? Command { get; set; }
    [JsonPropertyName("brokerGenerationId")] public string? BrokerGenerationId { get; set; }
    [JsonPropertyName("runToken")] public string? RunToken { get; set; }

    // ready
    [JsonPropertyName("protocolVersion")] public int? ProtocolVersion { get; set; }
    [JsonPropertyName("rid")] public string? Rid { get; set; }

    // launch
    [JsonPropertyName("executable")] public string? Executable { get; set; }
    [JsonPropertyName("args")] public string[]? Args { get; set; }
    [JsonPropertyName("workingDirectory")] public string? WorkingDirectory { get; set; }
}

internal sealed class BrokerResponse
{
    [JsonPropertyName("requestId")] public string? RequestId { get; set; }
    [JsonPropertyName("command")] public string? Command { get; set; }
    [JsonPropertyName("brokerGenerationId")] public string? BrokerGenerationId { get; set; }
    [JsonPropertyName("runToken")] public string? RunToken { get; set; }
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("code")] public string? Code { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }

    // ready
    [JsonPropertyName("protocolVersion")] public int? ProtocolVersion { get; set; }
    [JsonPropertyName("rid")] public string? Rid { get; set; }
    [JsonPropertyName("capabilities")] public string[]? Capabilities { get; set; }
    [JsonPropertyName("parentInJob")] public bool? ParentInJob { get; set; }
    [JsonPropertyName("pid")] public int? Pid { get; set; }

    // launch
    [JsonPropertyName("rootPid")] public int? RootPid { get; set; }
    [JsonPropertyName("rootStartTime")] public long? RootStartTime { get; set; }

    // enumerate / dispose
    [JsonPropertyName("count")] public int? Count { get; set; }
    [JsonPropertyName("pids")] public int[]? Pids { get; set; }
    [JsonPropertyName("disposed")] public bool? Disposed { get; set; }
    [JsonPropertyName("rootAlive")] public bool? RootAlive { get; set; }

    // diagnostics
    [JsonPropertyName("activeCount")] public int? ActiveCount { get; set; }
    [JsonPropertyName("tombstoneCount")] public int? TombstoneCount { get; set; }

    public string ToLine() => JsonSerializer.Serialize(this, BrokerJson.Default.BrokerResponse);
}

internal static class BrokerCodes
{
    public const string InvalidRequest = "INVALID_REQUEST";
    public const string GenerationMismatch = "GENERATION_MISMATCH";
    public const string UnknownCommand = "UNKNOWN_COMMAND";
    public const string TokenInUse = "TOKEN_IN_USE";
    public const string TokenRetired = "TOKEN_RETIRED";
    public const string UnknownToken = "UNKNOWN_TOKEN";
    public const string JobNotEmpty = "JOB_NOT_EMPTY";
    public const string LaunchFailed = "LAUNCH_FAILED";
    public const string CapacityExhausted = "CAPACITY_EXHAUSTED";
    public const string ActiveRunsRemain = "ACTIVE_RUNS_REMAIN";
    public const string Internal = "INTERNAL";
}
