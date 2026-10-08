namespace GptAccountKeeper.NetworkIsolation;

internal static class PreflightTests
{
    private static void Reject(System.Action action)
    {
        try { action(); } catch (ArgumentException) { return; }
        throw new Exception("Unsafe preflight input accepted");
    }
    internal static void Run()
    {
        var dynamic = PortPreflight.ParseDynamic("Start Port : 20000\r\nNumber of Ports : 1000\r\n");
        if (dynamic != new PortRange(20000, 20999)) throw new Exception("Dynamic range parsing failed");
        if (PortPreflight.ParseDynamic("起始端口 : 49152\n端口数 : 16384\n") != new PortRange(49152, 65535)) throw new Exception("Localized range parsing failed");
        var excluded = PortPreflight.ParseExcluded("Start Port End Port\n---------- --------\n 23002 23003 *\n");
        var inventory = new PortInventory([dynamic], excluded, [23004]);
        inventory.Check([23001]);
        foreach (ushort port in new ushort[] { 80, 20000, 20999, 23002, 23003, 23004 }) Reject(() => inventory.Check([port]));
        Reject(() => PortPreflight.ParseDynamic("query failed"));
        Reject(() => PortPreflight.ParseDynamic("Start: 65535\nCount: 2"));
        Reject(() => PortPreflight.ParseExcluded("query failed"));
        Reject(() => PortPreflight.ParseExcluded("---------- --------\n 23001 broken"));

        var root = Path.Combine(Path.GetTempPath(), "keeper-wfp-preflight-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var chrome = Path.Combine(root, "chrome"); Directory.CreateDirectory(chrome);
            var main = Path.Combine(chrome, "chrome.exe"); File.WriteAllText(main, "synthetic main");
            var helper = Path.Combine(chrome, "helper.exe"); File.WriteAllText(helper, "synthetic helper");
            var proxyDirectory = Path.Combine(root, "proxy"); Directory.CreateDirectory(proxyDirectory);
            var proxy = Path.Combine(proxyDirectory, "mihomo.exe"); File.WriteAllText(proxy, "synthetic proxy");
            File.WriteAllText(Path.Combine(root, "NETWORK_ISOLATION_LAB_ONLY"), "");
            var manifest = LabProgram.CreateManifest(chrome);
            var policy = new LabPolicy { Id = Guid.NewGuid(), LabRoot = root, ChromePath = main, ChromePrograms = manifest,
                Groups = [new LabGroup { Id = "a", ProxyPath = proxy, ProxySha256 = LabProgram.CreateManifest(proxyDirectory)[0].Sha256,
                    ListenerPort = 23001, Address = "192.0.2.1", Port = 443, Protocol = "tcp" }] };
            policy.Validate(true);
            Reject(() => (policy with { ChromePrograms = manifest.Where(program => program.Path != helper).ToArray() }).Validate(true));
            var added = Path.Combine(chrome, "new-helper.exe"); File.WriteAllText(added, "unregistered helper");
            Reject(() => policy.Validate(true)); File.Delete(added);
            var cleanupKeys = policy.ProtectedPrograms().Select(program => policy.Key($"deny/{program.Label}/v4")).ToArray();
            File.AppendAllText(helper, "tampered"); Reject(() => policy.Validate(true));
            policy.Validate(false); // Immutable cleanup keys still usable after tampering.
            File.Delete(helper); policy.Validate(false);
            if (!cleanupKeys.SequenceEqual(policy.ProtectedPrograms().Select(program => policy.Key($"deny/{program.Label}/v4"))))
                throw new Exception("Cleanup keys changed with runtime files");
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(root)) != Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar))
                throw new Exception("Unsafe test cleanup path");
            Directory.Delete(root, true);
        }
    }
}
