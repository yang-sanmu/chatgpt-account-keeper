using System.Text.Json;
using System.Text.Json.Serialization;

namespace GptAccountKeeper.Desktop.Models;

internal static class AgentProtocol
{
    public const int Major = 1;
    // 3 新增 queue.getSnapshot / browserRuns.* 与 queue.changed / browserRun.changed。
    // 必须与 Agent 侧 PROTOCOL_VERSION 同步：漏改事件名会在运行期被出站契约校验判为
    // INTERNAL 并销毁 socket，而不是启动期失败。
    public const int Minor = 3;
    public const int MaxFrameBytes = 8 * 1024 * 1024;
}

internal sealed record ProtocolVersionDto(
    [property: JsonPropertyName("major")] int Major,
    [property: JsonPropertyName("minor")] int Minor);

internal sealed record AgentHelloParams(
    [property: JsonPropertyName("protocol")] ProtocolVersionDto Protocol,
    [property: JsonPropertyName("clientVersion")] string ClientVersion,
    [property: JsonPropertyName("capabilities")] string[] Capabilities,
    [property: JsonPropertyName("authToken")] string AuthToken,
    [property: JsonPropertyName("dataRoot"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DataRoot);

internal sealed record AgentHelloResult(
    [property: JsonPropertyName("agentVersion")] string AgentVersion,
    [property: JsonPropertyName("protocol")] ProtocolRangeDto Protocol,
    [property: JsonPropertyName("capabilities")] string[] Capabilities,
    [property: JsonPropertyName("instanceId")] string InstanceId,
    [property: JsonPropertyName("dataRoot")] string? DataRoot);

internal sealed record ProtocolRangeDto(
    [property: JsonPropertyName("major")] int Major,
    [property: JsonPropertyName("minMinor")] int MinMinor,
    [property: JsonPropertyName("maxMinor")] int MaxMinor);

internal sealed class AgentRequestEnvelope
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("method")]
    public string Method { get; init; } = string.Empty;

    [JsonPropertyName("params")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public JsonElement Params { get; init; }

    [JsonPropertyName("commandId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CommandId { get; init; }
}

internal sealed class AgentIncomingEnvelope
{
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("result")]
    public JsonElement Result { get; init; }

    [JsonPropertyName("error")]
    public AgentErrorDto? Error { get; init; }

    [JsonPropertyName("event")]
    public string? Event { get; init; }

    [JsonPropertyName("seq")]
    public long? Sequence { get; init; }

    [JsonPropertyName("instanceId")]
    public string? InstanceId { get; init; }

    [JsonPropertyName("revision")]
    public long? Revision { get; init; }

    [JsonPropertyName("occurredAt")]
    public DateTimeOffset? OccurredAt { get; init; }

    [JsonPropertyName("payload")]
    public JsonElement Payload { get; init; }
}

internal sealed record AgentErrorDto(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("retryable")] bool Retryable,
    [property: JsonPropertyName("details")] JsonElement Details);

internal sealed record AgentEvent(
    string Name,
    long? Sequence,
    string? InstanceId,
    long? Revision,
    DateTimeOffset? OccurredAt,
    JsonElement Payload);

internal sealed class AgentRpcException : Exception
{
    public AgentRpcException(AgentErrorDto error)
        : base(error.Message)
    {
        Code = error.Code;
        Retryable = error.Retryable;
        Details = error.Details;
    }

    public string Code { get; }

    public bool Retryable { get; }

    public JsonElement Details { get; }
}
