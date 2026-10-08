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
    public required LabProgram[] ChromePrograms { get; init; }
    public required LabGroup[] Groups { get; init; }

    internal void Validate(bool files)
    {
        if (Id == Guid.Empty || Groups.Length is < 1 or > 4) throw new ArgumentException("Require a unique lab id and 1–4 groups");
        if (!Path.IsPathFullyQualified(LabRoot) || LabRoot.StartsWith(@"\\", StringComparison.Ordinal)
            || Path.GetFullPath(LabRoot) == Path.GetPathRoot(LabRoot)) throw new ArgumentException("LabRoot must be a dedicated local directory");
        ValidatePath(ChromePath, files);
        var chromeRoot = Path.GetDirectoryName(Path.GetFullPath(ChromePath))! + Path.DirectorySeparatorChar;
        if (ChromePrograms.Length is < 1 or > 256) throw new ArgumentException("Require a complete Chrome executable manifest");
        var manifestPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var program in ChromePrograms)
        {
            ValidatePath(program.Path, files);
            if (!Path.GetFullPath(program.Path).StartsWith(chromeRoot, StringComparison.OrdinalIgnoreCase)
                || !manifestPaths.Add(Path.GetFullPath(program.Path))) throw new ArgumentException("Chrome manifest has outside or duplicate paths");
            program.ValidateHash(files);
        }
        if (!manifestPaths.Contains(Path.GetFullPath(ChromePath))) throw new ArgumentException("Chrome main executable missing from manifest");
        if (files && !manifestPaths.SetEquals(LabProgram.CreateManifest(chromeRoot).Select(program => program.Path)))
            throw new ArgumentException("Chrome executable inventory changed; create a new policy generation before running");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var ports = new HashSet<ushort>();
        var paths = new HashSet<string>(manifestPaths, StringComparer.OrdinalIgnoreCase);
        foreach (var group in Groups)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(group.Id, "^[a-zA-Z0-9_-]{1,64}$")
                || !ids.Add(group.Id) || group.ListenerPort == 0 || !ports.Add(group.ListenerPort))
                throw new ArgumentException("Group ids and listener ports must be unique");
            ValidatePath(group.ProxyPath, files);
            new LabProgram { Path = group.ProxyPath, Sha256 = group.ProxySha256 }.ValidateHash(files);
            if (!paths.Add(Path.GetFullPath(group.ProxyPath))) throw new ArgumentException("Each proxy needs a separate executable path");
            if (!IPAddress.TryParse(group.Address, out var address) || address.ScopeIdOrZero() != 0
                || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)
                || group.Port == 0 || group.Protocol is not ("tcp" or "udp"))
                throw new ArgumentException("Upstream must have a numeric address, port and tcp/udp protocol");
        }
        if (files && !File.Exists(Path.Combine(LabRoot, "NETWORK_ISOLATION_LAB_ONLY")))
            throw new ArgumentException("Missing NETWORK_ISOLATION_LAB_ONLY marker; no host policy will be modified");
    }

    internal IEnumerable<(string Label, string Path)> ProtectedPrograms()
    {
        foreach (var program in ChromePrograms)
        {
            var main = string.Equals(Path.GetFullPath(program.Path), Path.GetFullPath(ChromePath), StringComparison.OrdinalIgnoreCase);
            var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(program.Path).ToUpperInvariant())));
            yield return (main ? "chrome" : $"chrome-helper/{id}", program.Path);
        }
        foreach (var group in Groups) yield return ($"proxy/{group.Id}", group.ProxyPath);
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
    public required string ProxySha256 { get; init; }
    public required ushort ListenerPort { get; init; }
    public required string Address { get; init; }
    public required ushort Port { get; init; }
    public required string Protocol { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LabProgram
{
    public required string Path { get; init; }
    public required string Sha256 { get; init; }

    internal void ValidateHash(bool files)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(Sha256, "^[0-9a-fA-F]{64}$")) throw new ArgumentException("Executable SHA-256 is required");
        if (files && !string.Equals(Hash(Path), Sha256, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Executable hash mismatch");
    }
    private static string Hash(string file) { using var stream = File.OpenRead(file); return Convert.ToHexString(SHA256.HashData(stream)); }
    internal static LabProgram[] CreateManifest(string directory)
    {
        var root = System.IO.Path.GetFullPath(directory);
        var pending = new Stack<string>(); pending.Push(root);
        var result = new List<LabProgram>();
        while (pending.TryPop(out var item))
        {
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Manifest cannot traverse reparse points");
            if (Directory.Exists(item)) { foreach (var child in Directory.EnumerateFileSystemEntries(item)) pending.Push(child); }
            else if (item.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) result.Add(new LabProgram { Path = item, Sha256 = Hash(item) });
            if (result.Count > 256) throw new ArgumentException("Too many Chrome executables");
        }
        return result.OrderBy(program => program.Path, StringComparer.OrdinalIgnoreCase).ToArray();
    }
}

internal static class AddressExtensions
{
    internal static long ScopeIdOrZero(this IPAddress address) =>
        address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? address.ScopeId : 0;
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(LabPolicy))]
[JsonSerializable(typeof(LabProgram[]))]
internal partial class LabJson : JsonSerializerContext { }
