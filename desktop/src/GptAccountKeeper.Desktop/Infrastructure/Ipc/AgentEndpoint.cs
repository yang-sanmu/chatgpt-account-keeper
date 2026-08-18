using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace GptAccountKeeper.Desktop.Infrastructure.Ipc;

internal enum AgentTransport
{
    NamedPipe,
    UnixDomainSocket,
}

internal sealed record AgentEndpoint(
    AgentTransport Transport,
    string Address,
    bool UseLegacyHandshake = false)
{
    public string DisplayName => Address;

    public string PipeName => Transport == AgentTransport.NamedPipe
        ? Address.Replace(@"\\.\pipe\", string.Empty, StringComparison.OrdinalIgnoreCase)
        : throw new InvalidOperationException("当前 endpoint 不是 Named Pipe");
}

internal static partial class AgentEndpointResolver
{
    private const string EndpointEnvironmentVariable = "GPTACCOUNTKEEPER_AGENT_ENDPOINT";

    public static AgentEndpoint Resolve(string dataRoot, bool useLegacyDefaultEndpoint = false)
    {
        var configured = Environment.GetEnvironmentVariable(EndpointEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Parse(configured.Trim());
        }

        return ResolveDefault(dataRoot, useLegacyDefaultEndpoint);
    }

    internal static AgentEndpoint ResolveDefault(string dataRoot, bool useLegacyEndpoint = false)
    {
        var dataScope = useLegacyEndpoint ? string.Empty : $"-{Hash(CanonicalDataRoot(dataRoot))}";

        if (OperatingSystem.IsWindows())
        {
            var identity = $"{Environment.UserDomainName}\\{Environment.UserName}";
            var suffix = Hash(identity);
            var channel = IsDevelopment() ? "dev-v1" : "v1";
            return new AgentEndpoint(
                AgentTransport.NamedPipe,
                $@"\\.\pipe\gptaccountkeeper-agent-{channel}-{suffix}{dataScope}",
                useLegacyEndpoint);
        }

        var runtimeDirectory = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
        if (string.IsNullOrWhiteSpace(runtimeDirectory))
        {
            runtimeDirectory = DefaultUnixRuntimeDirectory();
        }

        var uid = GetUnixUserId();
        var unixChannel = IsDevelopment() ? "dev-v1" : "v1";
        return new AgentEndpoint(
            AgentTransport.UnixDomainSocket,
            EnsureUnixSocketPathFits(
                Path.Combine(runtimeDirectory, $"kpr-agent-{unixChannel}-{uid}{dataScope}.sock")),
            useLegacyEndpoint);
    }

    internal static string CanonicalDataRoot(string dataRoot)
    {
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataRoot));
        return OperatingSystem.IsWindows() ? canonical.ToUpperInvariant() : canonical;
    }

    /// <summary>
    /// sockaddr_un.sun_path 的硬上限：Darwin 104 字节，Linux 108（含结尾 NUL）。
    /// </summary>
    internal static int UnixSocketPathLimit() => OperatingSystem.IsMacOS() ? 104 : 108;

    /// <summary>
    /// macOS 的 Path.GetTempPath() 是 /var/folders/xx/&lt;32 字符哈希&gt;/T/，约 51 字节，
    /// 拼上端点名后开发模式已经越界、生产模式只剩个位数余量。/tmp 短且稳定，
    /// 文件名里已经带 uid 和数据根哈希，不同用户不会互相撞。
    /// </summary>
    internal static string DefaultUnixRuntimeDirectory() =>
        OperatingSystem.IsMacOS() ? "/tmp" : Path.GetTempPath();

    /// <summary>
    /// 超限时 bind/connect 报的是 EINVAL 或静默截断，不会说"路径太长"，
    /// 所以自己先给一个能看懂的错误。按字节算，非 ASCII 路径会占多个字节。
    /// </summary>
    internal static string EnsureUnixSocketPathFits(string endpoint)
    {
        if (OperatingSystem.IsWindows()) return endpoint;
        var limit = UnixSocketPathLimit();
        var length = Encoding.UTF8.GetByteCount(endpoint);
        if (length >= limit)
        {
            throw new InvalidOperationException(
                $"IPC socket 路径超出系统上限（{length} >= {limit} 字节）：{endpoint}。" +
                "请把数据目录换到更短的路径，或设置 XDG_RUNTIME_DIR。");
        }
        return endpoint;
    }

    private static string Hash(string value)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(digest.AsSpan(0, 8)).ToLowerInvariant();
    }

    private static bool IsDevelopment() =>
        Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_DEVELOPMENT") is "1" or "true" or "TRUE";

    private static AgentEndpoint Parse(string value)
    {
        if (value.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase))
        {
            return new AgentEndpoint(AgentTransport.NamedPipe, value);
        }

        if (OperatingSystem.IsWindows() && !Path.IsPathRooted(value))
        {
            return new AgentEndpoint(AgentTransport.NamedPipe, $@"\\.\pipe\{value}");
        }

        return new AgentEndpoint(AgentTransport.UnixDomainSocket, Path.GetFullPath(value));
    }

    private static uint GetUnixUserId()
    {
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }

        return getuid();
    }

    [LibraryImport("libc", EntryPoint = "getuid")]
    private static partial uint getuid();
}
