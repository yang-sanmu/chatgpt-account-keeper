using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;
using static GptAccountKeeper.NetworkIsolation.NativeWfp;

namespace GptAccountKeeper.NetworkIsolation;

internal sealed record EncodedCondition(Guid Field, uint Match, uint Type, string Value);
internal sealed record EncodedFilter(Guid Key, Guid Layer, Guid ProviderKey, Guid Sublayer, uint Flags,
    uint Action, ulong Weight, EncodedCondition[] Conditions);
internal sealed record EncodingReport(string Kind, EncodedFilter[] Filters,
    bool WfpModified = false, bool ProductionReady = false, string LaunchAuthorization = "not_issued");

/// <summary>In-memory encoding only. No engine/session, AddFilter, or launch authority.
/// The input is an offline draft, not a trusted policy. Native acceptance is a separate lab gate.</summary>
internal static unsafe class WfpResourceEncoding
{
    private static string Text(JsonElement item, string name) => item.GetProperty(name).GetString()
        ?? throw new ArgumentException($"Missing {name}");
    private static Guid Layer(string name) => name switch {
        "FWPM_LAYER_ALE_AUTH_CONNECT_V4" => Connect4,
        "FWPM_LAYER_ALE_AUTH_CONNECT_V6" => Connect6,
        "FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4" => Bind4,
        "FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6" => Bind6,
        "FWPM_LAYER_ALE_AUTH_LISTEN_V4" => Listen4,
        "FWPM_LAYER_ALE_AUTH_LISTEN_V6" => Listen6,
        "FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4" => Receive4,
        "FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6" => Receive6,
        _ => throw new ArgumentException($"Unsupported layer: {name}"),
    };

    internal static EncodingReport Read(JsonElement root)
    {
        if (Text(root, "kind") != "offline_wfp_resources" || root.GetProperty("schemaVersion").GetInt32() != 1
            || Text(root, "isolationModel") != "group_path_v1" || Text(root, "launchAuthorization") != "not_issued")
            throw new ArgumentException("Expected an offline group_path_v1 resource draft, schema 1");
        var provider = root.GetProperty("provider").GetProperty("key").GetGuid();
        var sublayer = root.GetProperty("sublayer").GetProperty("key").GetGuid();
        if (root.GetProperty("sublayer").GetProperty("providerKey").GetGuid() != provider)
            throw new ArgumentException("Mismatched sublayer provider");
        var reports = new List<EncodedFilter>();
        var keys = new HashSet<Guid>();
        foreach (var item in root.GetProperty("filters").EnumerateArray())
        {
            // Per-filter ownership keeps peak allocation bounded by one filter.
            using var arena = new Arena();
            var filter = EncodeFilter(arena, item, provider, sublayer);
            if (!keys.Add(filter.Key)) throw new ArgumentException("Duplicate filter key");
            reports.Add(Describe(filter));
        }
        if (reports.Count == 0) throw new ArgumentException("Empty filter draft");
        return new EncodingReport("offline_wfp_encoding", reports.ToArray());
    }

    private static Filter EncodeFilter(Arena arena, JsonElement item, Guid provider, Guid sublayer)
    {
        var layerName = Text(item, "layer");
        var layer = Layer(layerName);
        var action = Text(item, "action") switch {
            "block" => Block, "permit" => Permit, _ => throw new ArgumentException("Unsupported action"),
        };
        var persistent = action == Block;
        var weight = item.GetProperty("weight").GetUInt64();
        if (item.GetProperty("clearActionRight").GetBoolean()
            || Text(item, "lifetime") != (persistent ? "persistent" : "dynamic")
            || weight != (persistent ? 10UL : 100UL)) throw new ArgumentException("Unsupported draft filter policy");
        var conditions = item.GetProperty("conditions").EnumerateArray()
            .Select(condition => EncodeCondition(arena, condition, layerName)).ToArray();
        if (conditions.Length == 0 || conditions.Select(c => c.Key).Distinct().Count() != conditions.Length)
            throw new ArgumentException("Empty or duplicate conditions");
        return new Filter {
            Key = item.GetProperty("key").GetGuid(), Display = new Display { Name = arena.Text("GptAccount offline WFP draft") },
            ProviderKey = arena.Struct(provider), Sublayer = sublayer, Layer = layer,
            Flags = persistent ? 1u : 0u, Action = new NativeWfp.Action { Type = action },
            Weight = new Value { Type = 4, Pointer = arena.Struct(weight) },
            Count = (uint)conditions.Length, Conditions = arena.Conditions(conditions),
        };
    }

    private static Condition EncodeCondition(Arena arena, JsonElement item, string layer)
    {
        if (Text(item, "match") != "FWP_MATCH_EQUAL") throw new ArgumentException("Unsupported match type");
        var field = Text(item, "field"); var type = Text(item, "type"); var value = item.GetProperty("value");
        // These are the only fields emitted by the compiler, checked per layer.
        var listen = layer.Contains("AUTH_LISTEN", StringComparison.Ordinal);
        var bind = layer.Contains("RESOURCE_ASSIGNMENT", StringComparison.Ordinal);
        if ((listen && field == "FWPM_CONDITION_IP_PROTOCOL")
            || ((listen || bind) && field is "FWPM_CONDITION_IP_REMOTE_ADDRESS" or "FWPM_CONDITION_IP_REMOTE_PORT"))
            throw new ArgumentException("Condition unavailable at this layer");
        var key = field switch {
            "FWPM_CONDITION_ALE_APP_ID" => AppId, "FWPM_CONDITION_ALE_USER_ID" => UserId,
            "FWPM_CONDITION_IP_LOCAL_ADDRESS" => LocalAddress, "FWPM_CONDITION_IP_REMOTE_ADDRESS" => RemoteAddress,
            "FWPM_CONDITION_IP_LOCAL_PORT" => LocalPort, "FWPM_CONDITION_IP_REMOTE_PORT" => RemotePort,
            "FWPM_CONDITION_IP_PROTOCOL" => Protocol, _ => throw new ArgumentException("Unsupported condition field"),
        };
        Value encoded;
        if (key == AppId && type == "application_path")
            encoded = new Value { Type = 12, Pointer = arena.Application(value.GetString() ?? throw new ArgumentException("Missing path")) };
        else if (key == UserId && type == "local_user_security_descriptor")
        {
            // A single allow ACE grants MATCH_FILTER (1), not traffic permission.
            // RawSecurityDescriptor emits the required self-relative binary form.
            var sid = new SecurityIdentifier(Text(value, "sid"));
            var acl = new RawAcl(GenericAcl.AclRevision, 1);
            acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 1, sid, false, null));
            var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.SelfRelative,
                null, null, null, acl);
            var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
            encoded = new Value { Type = 14, Pointer = arena.Struct(new Blob { Size = (uint)bytes.Length, Data = arena.Bytes(bytes) }) };
        }
        else if (key == Protocol && type == "FWP_UINT8")
            encoded = new Value { Type = 1, U8 = value.GetByte() };
        else if ((key == LocalPort || key == RemotePort) && type == "FWP_UINT16")
            encoded = new Value { Type = 2, U16 = value.GetUInt16() };
        else if ((key == LocalAddress || key == RemoteAddress) && type is "FWP_V4_ADDR_MASK" or "FWP_V6_ADDR_MASK")
        {
            var ip = IPAddress.Parse(Text(value, "address")); var prefix = value.GetProperty("prefixLength").GetInt32();
            var v4 = type == "FWP_V4_ADDR_MASK";
            if (v4 != layer.EndsWith("_V4", StringComparison.Ordinal)
                || ip.AddressFamily != (v4 ? AddressFamily.InterNetwork : AddressFamily.InterNetworkV6)
                || (!v4 && ip.ScopeId != 0) || prefix < 0 || prefix > (v4 ? 32 : 128))
                throw new ArgumentException("Address family or prefix mismatch");
            var bytes = ip.GetAddressBytes();
            if (v4)
                encoded = new Value { Type = 256, Pointer = arena.Struct(new V4Mask {
                    Address = BinaryPrimitives.ReadUInt32BigEndian(bytes), Mask = prefix == 0 ? 0 : uint.MaxValue << (32 - prefix),
                }) };
            else
            {
                var mask = new V6Mask { PrefixLength = (byte)prefix };
                bytes.CopyTo(new Span<byte>(mask.Address, 16));
                encoded = new Value { Type = 257, Pointer = arena.Struct(mask) };
            }
        }
        else throw new ArgumentException("Condition field/type mismatch");
        return new Condition { Key = key, Match = 0, Value = encoded };
    }

    // Read back the unmanaged structures while their arena is alive. This is a
    // diagnostic of bytes/pointers, not a claim that BFE accepted the filters.
    private static EncodedFilter Describe(Filter filter)
    {
        var conditions = new ReadOnlySpan<Condition>((void*)filter.Conditions, checked((int)filter.Count));
        var reports = new List<EncodedCondition>();
        foreach (var condition in conditions)
        {
            var value = condition.Value; string text;
            switch (value.Type)
            {
                case 1: text = value.U8.ToString(); break;
                case 2: text = value.U16.ToString(); break;
                case 12:
                    var app = *(Blob*)value.Pointer;
                    text = Marshal.PtrToStringUni(app.Data, checked((int)app.Size / 2)).TrimEnd('\0'); break;
                case 14:
                    var sd = *(Blob*)value.Pointer; var bytes = new byte[sd.Size]; Marshal.Copy(sd.Data, bytes, 0, bytes.Length);
                    text = new RawSecurityDescriptor(bytes, 0).GetSddlForm(AccessControlSections.Access); break;
                case 256:
                    var v4 = *(V4Mask*)value.Pointer;
                    text = $"{v4.Address:x8}/{v4.Mask:x8}"; break;
                case 257:
                    var v6 = *(V6Mask*)value.Pointer;
                    text = $"{Convert.ToHexString(new ReadOnlySpan<byte>(v6.Address, 16))}/{v6.PrefixLength}"; break;
                default: throw new ArgumentException("Unknown encoded type");
            }
            reports.Add(new EncodedCondition(condition.Key, condition.Match, value.Type, text));
        }
        return new EncodedFilter(filter.Key, filter.Layer, *(Guid*)filter.ProviderKey, filter.Sublayer,
            filter.Flags, filter.Action.Type, *(ulong*)filter.Weight.Pointer, reports.ToArray());
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(EncodingReport))]
internal partial class EncodingJson : JsonSerializerContext { }
