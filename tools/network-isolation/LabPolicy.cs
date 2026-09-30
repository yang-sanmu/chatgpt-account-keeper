using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace GptAccountKeeper.NetworkIsolation;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LabPolicy
{
    public required Guid Id { get; init; }
    public required string LabRoot { get; init; }
    public required string ChromePath { get; init; }
    public required LabGroup[] Groups { get; init; }

    internal void Validate(bool files)
    {
        if (Id == Guid.Empty || Groups.Length is < 1 or > 4) throw new ArgumentException("Require a unique lab id and 1–4 groups");
        if (!Path.IsPathFullyQualified(LabRoot) || LabRoot.StartsWith(@"\\", StringComparison.Ordinal)
            || Path.GetFullPath(LabRoot) == Path.GetPathRoot(LabRoot)) throw new ArgumentException("LabRoot must be a dedicated local directory");
        ValidatePath(ChromePath, files);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var ports = new HashSet<ushort>();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFullPath(ChromePath) };
        foreach (var group in Groups)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(group.Id, "^[a-zA-Z0-9_-]{1,64}$")
                || !ids.Add(group.Id) || group.ListenerPort == 0 || !ports.Add(group.ListenerPort))
                throw new ArgumentException("Group ids and listener ports must be unique");
            ValidatePath(group.ProxyPath, files);
            if (!paths.Add(Path.GetFullPath(group.ProxyPath))) throw new ArgumentException("Each proxy needs a separate executable path");
            if (!IPAddress.TryParse(group.Address, out var address) || address.ScopeIdOrZero() != 0
                || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)
                || group.Port == 0 || group.Protocol is not ("tcp" or "udp"))
                throw new ArgumentException("Upstream must have a numeric address, port and tcp/udp protocol");
        }
        if (files && !File.Exists(Path.Combine(LabRoot, "NETWORK_ISOLATION_LAB_ONLY")))
            throw new ArgumentException("Missing NETWORK_ISOLATION_LAB_ONLY marker; no host policy will be modified");
    }

    private void ValidatePath(string path, bool files)
    {
        var root = Path.GetFullPath(LabRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(path);
        if (!Path.IsPathFullyQualified(path) || !full.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            || !full.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Only .exe copies inside LabRoot may be filtered");
        if (!files) return;
        if (!File.Exists(full)) throw new ArgumentException("Lab executable missing");
        for (var item = full; !string.IsNullOrEmpty(item); item = Path.GetDirectoryName(item))
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Reparse points are not permitted in lab executable paths");
    }

    internal Guid Key(string label)
    {
        // Configuration changes require a new Id; never reuse another lab's filter keys.
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"GptAccountKeeper.NetworkLab.v3/{Id:D}/{label}"));
        return new Guid(bytes.AsSpan(0, 16));
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LabGroup
{
    public required string Id { get; init; }
    public required string ProxyPath { get; init; }
    public required ushort ListenerPort { get; init; }
    public required string Address { get; init; }
    public required ushort Port { get; init; }
    public required string Protocol { get; init; }
}

internal static class AddressExtensions
{
    internal static long ScopeIdOrZero(this IPAddress address) =>
        address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? address.ScopeId : 0;
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(LabPolicy))]
internal partial class LabJson : JsonSerializerContext { }
