using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace GptAccountKeeper.NetworkIsolation;

internal sealed record V4LabGroup(string Key, Guid[] Support, Guid[] Business);
internal sealed record V4LabReceipt(string Kind, Guid RunId, string LabRoot, JsonElement Resources, EncodedFilter[] Filters)
{
    internal Guid Provider => Resources.GetProperty("provider").GetProperty("key").GetGuid();
    internal Guid Sublayer => Resources.GetProperty("sublayer").GetProperty("key").GetGuid();
    internal ushort SublayerWeight => Resources.GetProperty("sublayer").GetProperty("weight").GetUInt16();
    internal V4LabGroup[] Groups => Resources.GetProperty("groups").EnumerateArray().Select(group => {
        var key = group.GetProperty("key").GetString()!;
        var business = group.GetProperty("freezeKeys").EnumerateArray().Select(item => item.GetGuid()).ToArray();
        var support = Resources.GetProperty("filters").EnumerateArray().Where(f => f.GetProperty("groupKey").GetString() == key
            && f.GetProperty("lifetime").GetString() == "dynamic").Select(f => f.GetProperty("key").GetGuid()).Except(business).ToArray();
        return new V4LabGroup(key, support, business);
    }).ToArray();

    internal static V4LabReceipt Prepare(JsonElement resources, string labRoot)
    {
        var root = RuntimeInventory.CheckedDirectory(labRoot);
        var receipt = new V4LabReceipt("v4_lab_receipt", Guid.NewGuid(), root, resources.Clone(), WfpResourceEncoding.Read(resources).Filters);
        receipt.Validate(); receipt.CheckFilesAndPorts(); return receipt;
    }

    internal void Validate()
    {
        if (Kind != "v4_lab_receipt" || RunId == Guid.Empty || Provider == Guid.Empty || Sublayer == Guid.Empty
            || Resources.GetProperty("kind").GetString() != "offline_wfp_resources"
            || Resources.GetProperty("schemaVersion").GetInt32() != 1 || Resources.GetProperty("isolationModel").GetString() != "group_path_v1"
            || Resources.GetProperty("launchAuthorization").GetString() != "not_issued"
            || !Resources.GetProperty("provider").GetProperty("persistent").GetBoolean()
            || !Resources.GetProperty("sublayer").GetProperty("persistent").GetBoolean()
            || Resources.GetProperty("sublayer").GetProperty("providerKey").GetGuid() != Provider || SublayerWeight != 0x7000)
            throw new ArgumentException("Invalid v4 lab receipt");
        if (!Path.IsPathFullyQualified(LabRoot) || !Regex.IsMatch(LabRoot, @"^[a-zA-Z]:\\")
            || Path.GetFullPath(LabRoot) != LabRoot || LabRoot == Path.GetPathRoot(LabRoot)) throw new ArgumentException("Dedicated lab root required");
        var programs = Programs();
        if (programs.Count == 0) throw new ArgumentException("Empty lab program inventory");
        foreach (var path in programs.Keys)
            if (!Path.IsPathFullyQualified(path) || !path.StartsWith(LabRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || Path.GetFullPath(path) != path || path.AsSpan(2).Contains(':'))
                throw new ArgumentException("Only executable copies below LabRoot may be used");
        if (Filters.Length == 0 || Filters.Select(f => f.Key).Distinct().Count() != Filters.Length
            || Filters.Any(f => f.Key == Guid.Empty || f.ProviderKey != Provider || f.Sublayer != Sublayer
                || (f.Action == NativeWfp.Block ? f.Flags != 1 || f.Weight != 10 : f.Action != NativeWfp.Permit || f.Flags != 0 || f.Weight != 100)))
            throw new ArgumentException("Invalid filter inventory");
        var source = Resources.GetProperty("filters").EnumerateArray().ToDictionary(f => f.GetProperty("key").GetGuid());
        if (!source.Keys.ToHashSet().SetEquals(Filters.Select(f => f.Key))) throw new ArgumentException("Filter keys differ from resources");
        var groups = Groups;
        if (groups.Length is < 1 or > 4 || groups.Select(g => g.Key).Distinct().Count() != groups.Length)
            throw new ArgumentException("Require 1–4 unique lab groups");
        var assigned = new HashSet<Guid>();
        foreach (var group in groups)
        {
            if (group.Business.Length != 2 || !group.Business.Select(key => source[key].GetProperty("purpose").GetString())
                .ToHashSet().SetEquals(["browser_entry_allow", "proxy_upstream_allow"])) throw new ArgumentException("Incomplete two-ended freeze set");
            foreach (var key in group.Support.Concat(group.Business))
                if (!assigned.Add(key) || source[key].GetProperty("groupKey").GetString() != group.Key
                    || Filters.Single(f => f.Key == key).Action != NativeWfp.Permit) throw new ArgumentException("Invalid group permission ownership");
        }
        if (!assigned.SetEquals(Filters.Where(f => f.Action == NativeWfp.Permit).Select(f => f.Key))) throw new ArgumentException("Unowned permissions");
        var cleanup = Resources.GetProperty("cleanupKeys");
        foreach (var (name, action) in new[] { ("dynamic", NativeWfp.Permit), ("persistent", NativeWfp.Block) })
            if (!cleanup.GetProperty(name).EnumerateArray().Select(v => v.GetGuid()).ToHashSet().SetEquals(Filters.Where(f => f.Action == action).Select(f => f.Key)))
                throw new ArgumentException("Incomplete cleanup inventory");
        if (cleanup.GetProperty("provider").GetGuid() != Provider || cleanup.GetProperty("sublayer").GetGuid() != Sublayer)
            throw new ArgumentException("Cleanup ownership mismatch");
        foreach (var filter in source.Values)
        {
            var conditions = filter.GetProperty("conditions").EnumerateArray().ToArray();
            var apps = conditions.Where(c => c.GetProperty("field").GetString() == "FWPM_CONDITION_ALE_APP_ID").ToArray();
            if (apps.Length == 1 && programs.ContainsKey(apps[0].GetProperty("value").GetString()!)) continue;
            // The only pathless rules allowed in this lab are exact-port default denials.
            if (apps.Length != 0 || filter.GetProperty("action").GetString() != "block"
                || !conditions.Any(c => c.GetProperty("field").GetString() is "FWPM_CONDITION_IP_LOCAL_PORT" or "FWPM_CONDITION_IP_REMOTE_PORT"
                    && c.GetProperty("value").GetInt32() is >= 1024 and <= 65535)) throw new ArgumentException("Unscoped lab filter");
        }
    }

    internal Dictionary<string, string> Programs()
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in Resources.GetProperty("groups").EnumerateArray().SelectMany(g => g.GetProperty("programs").EnumerateArray())
            .Concat(Resources.GetProperty("controllers").EnumerateArray()))
        {
            var path = item.GetProperty("path").GetString()!; var hash = item.GetProperty("sha256").GetString()!;
            if (!Regex.IsMatch(hash, "^[0-9a-f]{64}$") || (result.TryGetValue(path, out var old) && old != hash)) throw new ArgumentException("Invalid program hash");
            result[path] = hash;
        }
        return result;
    }

    internal void CheckFilesAndPorts()
    {
        RuntimeInventory.CheckedDirectory(LabRoot);
        if (!File.Exists(Path.Combine(LabRoot, "NETWORK_ISOLATION_LAB_ONLY"))) throw new ArgumentException("Missing NETWORK_ISOLATION_LAB_ONLY marker");
        foreach (var (path, hash) in Programs())
            if (RuntimeInventory.ReadProgram(path).Sha256 != hash) throw new ArgumentException("Lab program hash mismatch");
        foreach (var group in Resources.GetProperty("groups").EnumerateArray())
        {
            var main = group.GetProperty("programs").EnumerateArray().Single(p => p.GetProperty("role").GetString() == "chrome"
                && string.Equals(Path.GetFileName(p.GetProperty("path").GetString()), "chrome.exe", StringComparison.OrdinalIgnoreCase));
            var manifest = RuntimeInventory.ReadChrome(Path.GetDirectoryName(main.GetProperty("path").GetString())!);
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            {
                writer.WriteStartArray(); writer.WriteStringValue(manifest.Version); writer.WriteStartArray();
                foreach (var file in manifest.Files.OrderBy(f => f.RelativePath.ToLowerInvariant(), StringComparer.Ordinal))
                {
                    writer.WriteStartObject(); writer.WriteString("relativePath", file.RelativePath); writer.WriteNumber("sizeBytes", file.SizeBytes);
                    writer.WriteString("sha256", file.Sha256); writer.WriteEndObject();
                }
                writer.WriteEndArray(); writer.WriteEndArray();
            }
            if (Convert.ToHexString(SHA256.HashData(buffer.ToArray())).ToLowerInvariant() != group.GetProperty("inventoryHash").GetString())
                throw new ArgumentException("Complete Chrome inventory changed");
        }
        var encoded = WfpResourceEncoding.Read(Resources).Filters;
        if (encoded.Length != Filters.Length || encoded.Any(f => !V4LabLifecycle.Equal(f, Filters.Single(e => e.Key == f.Key))))
            throw new ArgumentException("Receipt encoding differs from current resource paths");
        var ports = Resources.GetProperty("filters").EnumerateArray().Where(f => f.GetProperty("action").GetString() == "block")
            .SelectMany(f => f.GetProperty("conditions").EnumerateArray()).Where(c => c.GetProperty("field").GetString() == "FWPM_CONDITION_IP_LOCAL_PORT")
            .Select(c => c.GetProperty("value").GetUInt16()).Distinct();
        PortPreflight.Read().Check(ports);
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(V4LabReceipt))]
internal partial class V4ReceiptJson : JsonSerializerContext { }
