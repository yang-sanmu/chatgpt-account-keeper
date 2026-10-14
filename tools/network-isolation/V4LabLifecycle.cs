namespace GptAccountKeeper.NetworkIsolation;

internal sealed record V4Object(string Kind, Guid Key, Guid RunId, uint Flags,
    Guid? ProviderKey = null, ushort Weight = 0, string? ServiceName = null, EncodedFilter? Filter = null);
internal sealed record V4Observation(V4Object Expected, V4Object? Actual, string Status);

// The fake implementation exercises transaction ordering without opening BFE.
internal interface IV4LabStore : IDisposable
{
    V4Object? Read(string kind, Guid key);
    void Transaction(bool dynamic, System.Action action);
    void OpenDynamic();
    void Add(V4Object item);
    void Remove(V4Object item);
}

internal sealed class V4LabLifecycle(V4LabReceipt receipt, IV4LabStore store)
{
    private bool installed;
    internal V4Object[] Objects { get; } = [
        new("provider", receipt.Provider, receipt.RunId, 1),
        new("sublayer", receipt.Sublayer, receipt.RunId, 1, receipt.Provider, receipt.SublayerWeight),
        .. receipt.Filters.Select(f => new V4Object("filter", f.Key, receipt.RunId, f.Flags, f.ProviderKey, Filter: f)),
    ];
    private IEnumerable<V4Object> Durable => Objects.Where(o => o.Flags == 1);
    private IEnumerable<V4Object> Permissions => Objects.Where(o => o.Flags == 0);
    private V4LabGroup Group(string key) => receipt.Groups.SingleOrDefault(g => g.Key == key)
        ?? throw new ArgumentException("Unknown lab group");
    private V4Object Filter(Guid key) => Objects.Single(o => o.Kind == "filter" && o.Key == key);

    internal static bool Equal(EncodedFilter a, EncodedFilter b) => a with { Conditions = b.Conditions } == b
        && a.Conditions.OrderBy(c => c.Field).SequenceEqual(b.Conditions.OrderBy(c => c.Field));
    internal static bool Equal(V4Object a, V4Object b, bool cleanup = false)
    {
        // Disabled objects are not ready for activation. They may still be removed
        // during explicit cleanup; all other content and the run tag must match.
        if (cleanup)
        {
            var flags = a.Flags & ~(a.Kind == "provider" ? 0x10u : a.Kind == "filter" ? 0x20u : 0u);
            a = a with { Flags = flags, Filter = a.Filter is null ? null : a.Filter with { Flags = flags } };
        }
        return a with { Filter = b.Filter } == b && (a.Filter is null ? b.Filter is null : b.Filter is not null && Equal(a.Filter, b.Filter));
    }
    private V4Object? Checked(V4Object expected, bool required = false, bool cleanup = false)
    {
        var actual = store.Read(expected.Kind, expected.Key);
        if (actual is null && required) throw new InvalidOperationException($"Missing {expected.Kind}: {expected.Key}");
        if (actual is not null && !Equal(actual, expected, cleanup)) throw new InvalidOperationException($"Ownership/content mismatch: {expected.Key}");
        return actual;
    }
    internal V4Observation[] Inspect() => Objects.Select(expected => {
        var actual = store.Read(expected.Kind, expected.Key);
        return new V4Observation(expected, actual, actual is null ? "missing" : Equal(actual, expected) ? "matches" : "mismatch");
    }).ToArray();

    internal void Install()
    {
        if (installed) throw new InvalidOperationException("Already installed by this session");
        store.Transaction(false, () => {
            foreach (var expected in Objects)
                if (store.Read(expected.Kind, expected.Key) is not null) throw new InvalidOperationException("Existing resources require explicit cleanup with their original receipt");
            foreach (var item in Durable) store.Add(item);
        });
        // Failure opening the dynamic session deliberately leaves committed denials.
        store.OpenDynamic(); installed = true;
    }
    private void Ready()
    {
        if (!installed) throw new InvalidOperationException("Install first in this process");
        foreach (var item in Durable) Checked(item, required: true);
    }
    private void Allow(Guid[] keys)
    {
        var items = keys.Select(Filter).ToArray();
        var present = items.Count(item => Checked(item) is not null);
        if (present == items.Length) return;
        if (present != 0) throw new InvalidOperationException("Partial permission set; stop and inspect the lab");
        foreach (var item in items) store.Add(item);
    }
    internal void Listen(string groupKey)
    {
        var group = Group(groupKey);
        store.Transaction(true, () => { Ready(); Allow(group.Support); });
    }
    internal void Activate(string groupKey)
    {
        var group = Group(groupKey);
        store.Transaction(true, () => {
            Ready(); foreach (var key in group.Support) Checked(Filter(key), required: true);
            Allow(group.Business);
        });
    }
    internal void Freeze(string? groupKey)
    {
        var groups = groupKey is null ? receipt.Groups : [Group(groupKey)];
        if (!installed) throw new InvalidOperationException("Install first in this process");
        store.Transaction(true, () => {
            foreach (var key in groups.SelectMany(g => g.Business))
            {
                var item = Filter(key);
                if (Checked(item) is not null) store.Remove(item);
            }
            // Never report a successful freeze if its default denial disappeared.
            foreach (var item in Durable) Checked(item, required: true);
        });
    }
    internal void Cleanup()
    {
        store.Transaction(false, () => {
            foreach (var item in Permissions)
                if (store.Read(item.Kind, item.Key) is not null) throw new InvalidOperationException("Dynamic permissions still present; stop their owner before cleanup");
            // Validate everything before removing anything. Reverse dependency order.
            var present = Durable.Where(item => Checked(item, cleanup: true) is not null).Reverse().ToArray();
            foreach (var item in present) store.Remove(item);
        });
    }
}
