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
            runtimeDirectory = Path.GetTempPath();
        }

        var uid = GetUnixUserId();
        var unixChannel = IsDevelopment() ? "dev-v1" : "v1";
        return new AgentEndpoint(
            AgentTransport.UnixDomainSocket,
            Path.Combine(runtimeDirectory, $"gptaccountkeeper-agent-{unixChannel}-{uid}{dataScope}.sock"),
            useLegacyEndpoint);
    }

    internal static string CanonicalDataRoot(string dataRoot)
    {
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataRoot));
        return OperatingSystem.IsWindows() ? canonical.ToUpperInvariant() : canonical;
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
