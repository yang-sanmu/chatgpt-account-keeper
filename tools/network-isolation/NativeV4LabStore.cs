using static GptAccountKeeper.NetworkIsolation.NativeWfp;

namespace GptAccountKeeper.NetworkIsolation;

internal sealed unsafe class NativeV4LabStore(V4LabReceipt receipt) : IV4LabStore
{
    private readonly Engine durable = new(false);
    private Engine? temporary;
    private Engine? transaction;
    private nint Handle => (transaction ?? durable).Handle;
    private static Guid Tag(Blob blob) => blob.Size == 16 && blob.Data != 0 ? new Guid(new ReadOnlySpan<byte>((void*)blob.Data, 16)) : Guid.Empty;
    private static Blob Data(Arena arena, Guid tag) => new() { Size = 16, Data = arena.Bytes(tag.ToByteArray()) };

    public V4Object? Read(string kind, Guid key)
    {
        nint pointer; uint result; uint missing;
        switch (kind)
        {
            case "provider": result = GetProvider(Handle, key, out pointer); missing = ProviderNotFound; break;
            case "sublayer": result = GetSublayer(Handle, key, out pointer); missing = SublayerNotFound; break;
            case "filter": result = GetFilter(Handle, key, out pointer); missing = FilterNotFound; break;
            default: throw new ArgumentException("Unknown WFP object kind");
        }
        if (result == missing) return null;
        Check(result, "Read v4 " + kind);
        try
        {
            if (kind == "provider")
            {
                var p = *(Provider*)pointer;
                return new(kind, p.Key, Tag(p.Data), p.Flags, ServiceName: System.Runtime.InteropServices.Marshal.PtrToStringUni(p.ServiceName));
            }
            if (kind == "sublayer")
            {
                var s = *(Sublayer*)pointer;
                return new(kind, s.Key, Tag(s.Data), s.Flags, s.ProviderKey == 0 ? null : *(Guid*)s.ProviderKey, s.Weight);
            }
            var f = *(Filter*)pointer;
            return new(kind, f.Key, Tag(f.Data), f.Flags, f.ProviderKey == 0 ? null : *(Guid*)f.ProviderKey, Filter: WfpResourceEncoding.Describe(f));
        }
        finally { Free(ref pointer); }
    }
    public void OpenDynamic()
    {
        if (temporary is not null) throw new InvalidOperationException("Dynamic session already open");
        temporary = new Engine(true);
    }
    public void Transaction(bool dynamic, System.Action action)
    {
        if (transaction is not null) throw new InvalidOperationException("Nested transaction");
        transaction = dynamic ? temporary ?? throw new InvalidOperationException("No dynamic session") : durable;
        try { transaction.Transaction(action); } finally { transaction = null; }
    }
    public void Add(V4Object item)
    {
        if (transaction is null) throw new InvalidOperationException("Transaction required");
        using var arena = new Arena();
        var display = new Display { Name = arena.Text("GptAccount v4 dedicated lab") };
        var data = Data(arena, item.RunId);
        if (item.Kind == "provider")
        {
            var provider = new Provider { Key = item.Key, Display = display, Flags = item.Flags, Data = data };
            Check(AddProvider(Handle, provider, 0), "Add v4 provider");
        }
        else if (item.Kind == "sublayer")
        {
            var sublayer = new Sublayer { Key = item.Key, Display = display, Flags = item.Flags, Data = data,
                ProviderKey = arena.Struct(item.ProviderKey!.Value), Weight = item.Weight };
            Check(AddSublayer(Handle, sublayer, 0), "Add v4 sublayer");
        }
        else
        {
            var source = receipt.Resources.GetProperty("filters").EnumerateArray().Single(f => f.GetProperty("key").GetGuid() == item.Key);
            var filter = WfpResourceEncoding.EncodeFilter(arena, source, receipt.Provider, receipt.Sublayer);
            if (item.Filter is null || !V4LabLifecycle.Equal(WfpResourceEncoding.Describe(filter), item.Filter))
                throw new ArgumentException("Filter encoding changed since preparation");
            filter.Display = display; filter.Data = data;
            Check(AddFilter(Handle, filter, 0, out _), "Add v4 filter");
        }
    }
    public void Remove(V4Object item)
    {
        if (transaction is null) throw new InvalidOperationException("Transaction required");
        Check(item.Kind switch {
            "filter" => DeleteFilter(Handle, item.Key), "sublayer" => DeleteSublayer(Handle, item.Key),
            "provider" => DeleteProvider(Handle, item.Key), _ => throw new ArgumentException("Unknown WFP object kind"),
        }, "Remove v4 " + item.Kind);
    }
    public void Dispose() { try { temporary?.Dispose(); } finally { durable.Dispose(); } }
}
