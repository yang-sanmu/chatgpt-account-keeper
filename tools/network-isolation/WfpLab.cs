using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using static GptAccountKeeper.NetworkIsolation.NativeWfp;

namespace GptAccountKeeper.NetworkIsolation;

internal sealed class Arena : IDisposable
{
    private readonly List<nint> allocations = [];
    private readonly List<nint> wfpAllocations = [];
    internal nint Text(string value)
    {
        var pointer = Marshal.StringToHGlobalUni(value); allocations.Add(pointer); return pointer;
    }
    internal unsafe nint Struct<T>(T value) where T : unmanaged
    {
        var pointer = Marshal.AllocHGlobal(sizeof(T)); allocations.Add(pointer); *(T*)pointer = value; return pointer;
    }
    internal nint Bytes(byte[] value)
    {
        var pointer = Marshal.AllocHGlobal(value.Length); allocations.Add(pointer);
        Marshal.Copy(value, 0, pointer, value.Length); return pointer;
    }
    internal unsafe nint Conditions(Condition[] values)
    {
        var pointer = Marshal.AllocHGlobal(sizeof(Condition) * values.Length); allocations.Add(pointer);
        values.AsSpan().CopyTo(new Span<Condition>((void*)pointer, values.Length)); return pointer;
    }
    internal nint Application(string path)
    {
        Check(GetAppId(path, out var pointer), "GetAppId"); wfpAllocations.Add(pointer); return pointer;
    }
    public void Dispose()
    {
        foreach (var item in wfpAllocations) { var pointer = item; Free(ref pointer); }
        foreach (var item in allocations) Marshal.FreeHGlobal(item);
    }
}

internal sealed class Engine : IDisposable
{
    internal nint Handle { get; private set; }
    internal Engine(bool dynamic)
    {
        var session = new Session { Key = Guid.NewGuid(), Flags = dynamic ? 1u : 0u, Timeout = 5000 };
        Check(Open(0, 10, 0, session, out var handle), "EngineOpen"); Handle = handle;
    }
    internal void Transaction(System.Action action)
    {
        Check(Begin(Handle, 0), "TransactionBegin");
        try { action(); Check(Commit(Handle), "TransactionCommit"); }
        catch { Abort(Handle); throw; }
    }
    public void Dispose()
    {
        if (Handle == 0) return;
        var handle = Handle; Handle = 0; Check(Close(handle), "EngineClose");
    }
}

/// <summary>Lab-only implementation. It installs no Windows service and changes no route/DNS setting.</summary>
internal sealed class WfpLab : IDisposable
{
    private readonly LabPolicy policy;
    private readonly Engine durable = new(false);
    private Engine? temporary;
    private readonly HashSet<string> active = new(StringComparer.Ordinal);

    internal WfpLab(LabPolicy policy) { this.policy = policy; }
    private Guid ProviderKey => policy.Key("provider");
    private Guid SublayerKey => policy.Key("sublayer");

    internal IEnumerable<(string Label, string Path)> ProtectedPrograms()
    {
        yield return ("chrome", policy.ChromePath);
        foreach (var group in policy.Groups) yield return ($"proxy/{group.Id}", group.ProxyPath);
    }
    private IEnumerable<string> DurableLabels()
    {
        foreach (var (label, _) in ProtectedPrograms())
        {
            yield return $"deny/{label}/v4"; yield return $"deny/{label}/v6";
        }
        foreach (var group in policy.Groups)
        {
            yield return $"bind/{group.Id}/v4"; yield return $"bind/{group.Id}/v6";
        }
    }
    private static Condition App(Arena arena, string path, uint match = 0) =>
        new() { Key = AppId, Match = match, Value = new Value { Type = 12, Pointer = arena.Application(path) } };
    private static Condition ProtocolCondition(byte protocol) =>
        new() { Key = Protocol, Value = new Value { Type = 1, U8 = protocol } };
    private static Condition PortCondition(Guid key, ushort port) =>
        new() { Key = key, Value = new Value { Type = 2, U16 = port } };
    private static Condition Address(Arena arena, IPAddress address) => new()
    {
        Key = RemoteAddress,
        Value = address.AddressFamily == AddressFamily.InterNetwork
            ? new Value { Type = 3, U32 = BinaryPrimitives.ReadUInt32BigEndian(address.GetAddressBytes()) }
            : new Value { Type = 11, Pointer = arena.Bytes(address.GetAddressBytes()) },
    };
    private void Add(Engine engine, Arena arena, string label, Guid layer, bool persistent, uint action, Condition[] conditions)
    {
        var filter = new Filter {
            Key = policy.Key(label), Display = new Display { Name = arena.Text($"GptAccount network lab: {label}") },
            Flags = persistent ? 1u : 0u, ProviderKey = arena.Struct(ProviderKey), Layer = layer, Sublayer = SublayerKey,
            // Same-sublayer exceptions precede the catch-all. No CLEAR_ACTION_RIGHT hard permit.
            Weight = new Value { Type = 4, Pointer = arena.Struct(action == Permit ? 100UL : 1UL) },
            Count = (uint)conditions.Length, Conditions = arena.Conditions(conditions), Action = new NativeWfp.Action { Type = action },
        };
        Check(AddFilter(engine.Handle, filter, 0, out _), $"AddFilter/{label}");
    }

    internal void Install()
    {
        using var arena = new Arena();
        durable.Transaction(() => {
            // No serviceName: durable protection must survive an absent/disabled helper.
            var provider = new Provider { Key = ProviderKey, Flags = 1,
                Display = new Display { Name = arena.Text("GptAccount network isolation LAB ONLY") } };
            Check(AddProvider(durable.Handle, provider, 0), "AddProvider (new lab id required)");
            var sublayer = new Sublayer { Key = SublayerKey, Flags = 1, ProviderKey = arena.Struct(ProviderKey), Weight = 0x7000,
                Display = new Display { Name = arena.Text("GptAccount network lab") } };
            Check(AddSublayer(durable.Handle, sublayer, 0), "AddSublayer");
            foreach (var (label, path) in ProtectedPrograms())
            {
                Add(durable, arena, $"deny/{label}/v4", Connect4, true, Block, [App(arena, path)]);
                Add(durable, arena, $"deny/{label}/v6", Connect6, true, Block, [App(arena, path)]);
            }
            foreach (var group in policy.Groups)
            {
                // Covers wildcard and IPv6 binds too. Only the group's exact executable may bind this port.
                foreach (var (family, layer) in new[] { ("v4", Bind4), ("v6", Bind6) })
                    Add(durable, arena, $"bind/{group.Id}/{family}", layer, true, Block,
                        [App(arena, group.ProxyPath, 10), ProtocolCondition(6), PortCondition(LocalPort, group.ListenerPort)]);
            }
        });
        temporary = new Engine(true);
    }

    internal void Activate(string groupId)
    {
        var group = policy.Groups.Single(item => item.Id == groupId);
        if (temporary == null) throw new InvalidOperationException("Install first");
        if (active.Contains(groupId)) return;
        using var arena = new Arena();
        var address = IPAddress.Parse(group.Address);
        temporary.Transaction(() => {
            Add(temporary, arena, $"allow/chrome/{group.Id}", Connect4, false, Permit,
                [App(arena, policy.ChromePath), ProtocolCondition(6), Address(arena, IPAddress.Loopback), PortCondition(RemotePort, group.ListenerPort)]);
            Add(temporary, arena, $"allow/proxy/{group.Id}", address.AddressFamily == AddressFamily.InterNetwork ? Connect4 : Connect6, false, Permit,
                [App(arena, group.ProxyPath), ProtocolCondition(group.Protocol == "tcp" ? (byte)6 : (byte)17),
                    Address(arena, address), PortCondition(RemotePort, group.Port)]);
        });
        active.Add(groupId);
    }

    internal void Freeze(string? groupId)
    {
        if (temporary == null) return;
        var groups = active.Where(id => groupId == null || id == groupId).ToArray();
        temporary.Transaction(() => {
            foreach (var id in groups)
                foreach (var role in new[] { "chrome", "proxy" })
                    Check(DeleteFilter(temporary.Handle, policy.Key($"allow/{role}/{id}")), "Freeze both ends");
        });
        foreach (var id in groups) active.Remove(id);
    }

    internal (int Present, int Expected) Inspect()
    {
        var present = 0; var expected = 0;
        foreach (var label in DurableLabels())
        {
            expected++;
            var result = GetFilter(durable.Handle, policy.Key(label), out var pointer);
            if (result == FilterNotFound) continue;
            Check(result, "GetFilter");
            try { present++; } finally { Free(ref pointer); }
        }
        return (present, expected);
    }

    internal void Cleanup()
    {
        // Explicit lab cleanup only; caller must have proved all lab processes stopped.
        temporary?.Dispose(); temporary = null; active.Clear();
        durable.Transaction(() => {
            foreach (var label in DurableLabels())
            {
                var result = DeleteFilter(durable.Handle, policy.Key(label));
                if (result != FilterNotFound) Check(result, "Delete lab filter");
            }
            var sub = DeleteSublayer(durable.Handle, SublayerKey);
            if (sub != SublayerNotFound) Check(sub, "Delete lab sublayer");
            var provider = DeleteProvider(durable.Handle, ProviderKey);
            if (provider != ProviderNotFound) Check(provider, "Delete lab provider");
        });
    }

    public void Dispose()
    {
        try { temporary?.Dispose(); } finally { durable.Dispose(); }
        // Durable deny is intentionally NOT removed on EOF/crash/exit.
    }
}
