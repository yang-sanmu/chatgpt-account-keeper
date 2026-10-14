namespace GptAccountKeeper.NetworkIsolation;

// In-memory transaction/fault tests. No native engine, process or socket is used.
internal static class V4LabLifecycleTests
{
    private sealed class MemoryStore : IV4LabStore
    {
        internal Dictionary<(string, Guid), V4Object> Items = [];
        internal int FailWrite;
        internal bool FailCommit, FailOpen;
        private bool dynamicOpen, transaction, dynamicTransaction;
        public V4Object? Read(string kind, Guid key) => Items.GetValueOrDefault((kind, key));
        public void OpenDynamic()
        {
            if (FailOpen) throw new InvalidOperationException("injected open failure");
            if (dynamicOpen) throw new InvalidOperationException("duplicate dynamic session");
            dynamicOpen = true;
        }
        public void Transaction(bool dynamic, System.Action action)
        {
            if (transaction || (dynamic && !dynamicOpen)) throw new InvalidOperationException("invalid transaction/session");
            var before = new Dictionary<(string, Guid), V4Object>(Items);
            transaction = true; dynamicTransaction = dynamic;
            try { action(); if (FailCommit) throw new InvalidOperationException("injected commit failure"); }
            catch { Items = before; throw; }
            finally { transaction = false; }
        }
        private void Write(V4Object item)
        {
            if (!transaction || (item.Flags == 0) != dynamicTransaction) throw new InvalidOperationException("Wrong object lifetime/session");
            if (FailWrite > 0 && --FailWrite == 0) throw new InvalidOperationException("injected write failure");
        }
        public void Add(V4Object item) { Write(item); Items.Add((item.Kind, item.Key), item); }
        public void Remove(V4Object item)
        {
            Write(item);
            if (Items.Values.Any(v => v.Key != item.Key && (v.ProviderKey == item.Key || v.Filter?.Sublayer == item.Key)))
                throw new InvalidOperationException("Object still referenced");
            if (!Items.Remove((item.Kind, item.Key))) throw new InvalidOperationException("Object missing");
        }
        public void Dispose()
        {
            foreach (var item in Items.Values.Where(i => i.Flags == 0).ToArray()) Items.Remove((item.Kind, item.Key));
            dynamicOpen = false;
        }
    }
    private static void Require(bool ok, string message) { if (!ok) throw new Exception("v4 lifecycle test: " + message); }
    private static void Reject(System.Action action, string message)
    {
        try { action(); } catch (Exception error) when (error is InvalidOperationException or ArgumentException)
        { Require(error.Message.Contains(message, StringComparison.OrdinalIgnoreCase), error.Message); return; }
        throw new Exception("v4 lifecycle test: expected rejection " + message);
    }
    internal static void Run(V4LabReceipt receipt)
    {
        var group = receipt.Groups[0];
        Require(group.Support.Length > 1, "fixture needs listener support");
        var durableCount = receipt.Filters.Count(f => f.Flags == 1) + 2;
        foreach (var at in new[] { 1, 3, durableCount })
        {
            using var fault = new MemoryStore { FailWrite = at };
            Reject(new V4LabLifecycle(receipt, fault).Install, "injected");
            Require(fault.Items.Count == 0, "install rollback");
        }
        using (var fault = new MemoryStore { FailCommit = true })
        {
            Reject(new V4LabLifecycle(receipt, fault).Install, "injected"); Require(fault.Items.Count == 0, "commit rollback");
        }
        using (var fault = new MemoryStore { FailOpen = true })
        {
            var failed = new V4LabLifecycle(receipt, fault);
            Reject(failed.Install, "injected"); Require(fault.Items.Count == durableCount, "dynamic-open failure retains denials");
            Reject(() => failed.Activate(group.Key), "transaction/session");
            failed.Cleanup(); Require(fault.Items.Count == 0, "failed-open cleanup");
        }
        using var store = new MemoryStore(); var lab = new V4LabLifecycle(receipt, store);
        lab.Install(); Require(store.Items.Count == durableCount, "default only");
        Reject(new V4LabLifecycle(receipt, store).Install, "Existing resources");
        Reject(() => lab.Activate(group.Key), "Missing");
        Reject(() => lab.Listen("unknown-group"), "Unknown");
        store.FailWrite = 2; Reject(() => lab.Listen(group.Key), "injected"); Require(store.Items.Count == durableCount, "support rollback");
        lab.Listen(group.Key); lab.Listen(group.Key);
        Require(store.Items.Count == durableCount + group.Support.Length, "support idempotent");
        store.FailWrite = 2; Reject(() => lab.Activate(group.Key), "injected");
        Require(group.Business.All(key => store.Read("filter", key) is null), "both permissions rollback");
        lab.Activate(group.Key); lab.Activate(group.Key);
        foreach (var other in receipt.Groups.Skip(1)) { lab.Listen(other.Key); lab.Activate(other.Key); }
        store.FailWrite = 2; Reject(() => lab.Freeze(group.Key), "injected");
        Require(group.Business.All(key => store.Read("filter", key) is not null), "both removals rollback");
        lab.Freeze(group.Key);
        Require(group.Business.All(key => store.Read("filter", key) is null), "business frozen");
        Require(group.Support.All(key => store.Read("filter", key) is not null), "CDP/listener retained");
        Require(receipt.Groups.Skip(1).SelectMany(g => g.Business).All(key => store.Read("filter", key) is not null), "other group unaffected");
        Reject(lab.Cleanup, "Dynamic permissions");
        lab.Freeze(null); store.Dispose(); Require(store.Items.Count == durableCount, "session loss retains denials");

        // Changed policy or a new experiment with identical keys cannot be adopted/deleted.
        var foreign = receipt with { RunId = Guid.NewGuid() };
        Reject(new V4LabLifecycle(foreign, store).Cleanup, "mismatch");
        var deny = store.Items.Values.First(o => o.Kind == "filter");
        store.Items[(deny.Kind, deny.Key)] = deny with { Filter = deny.Filter! with { Conditions = [] } };
        Require(lab.Inspect().Single(o => o.Expected.Key == deny.Key).Status == "mismatch", "condition mismatch readback");
        Reject(lab.Cleanup, "mismatch"); store.Items[(deny.Kind, deny.Key)] = deny;
        // A BFE-disabled object is visible as a mismatch, but can still be retired.
        store.Items[(deny.Kind, deny.Key)] = deny with { Flags = 0x21, Filter = deny.Filter! with { Flags = 0x21 } };
        var provider = store.Items[("provider", receipt.Provider)];
        store.Items[("provider", receipt.Provider)] = provider with { Flags = 0x11 };
        Require(lab.Inspect().Single(o => o.Expected.Key == deny.Key).Status == "mismatch", "disabled flag readback");
        store.FailWrite = 2; Reject(lab.Cleanup, "injected"); Require(store.Items.Count == durableCount, "cleanup rollback");
        lab.Cleanup(); lab.Cleanup(); Require(store.Items.Count == 0, "cleanup retry, dependency order");

        using var changed = new MemoryStore(); var guarded = new V4LabLifecycle(receipt, changed);
        guarded.Install(); guarded.Listen(group.Key);
        var activeProvider = changed.Items[("provider", receipt.Provider)];
        changed.Items[("provider", receipt.Provider)] = activeProvider with { Flags = 0x11 };
        Reject(() => guarded.Activate(group.Key), "mismatch");
        changed.Items[("provider", receipt.Provider)] = activeProvider;
        var missing = changed.Items.Values.First(o => o.Kind == "filter" && o.Flags == 1);
        changed.Items.Remove((missing.Kind, missing.Key));
        Reject(() => guarded.Activate(group.Key), "Missing");
        Require(group.Business.All(key => changed.Read("filter", key) is null), "lost denial cannot activate");
    }
}
