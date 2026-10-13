using System.Text.Json;
using GptAccountKeeper.NetworkIsolation;

try
{
    NativeWfp.CheckLayout();
    if (args.Length == 1 && args[0] == "selftest")
    {
        var sample = new LabPolicy { Id = Guid.NewGuid(), LabRoot = @"C:\NetworkLab", ChromePath = @"C:\NetworkLab\chrome\chrome.exe",
            ChromePrograms = [new LabProgram { Path = @"C:\NetworkLab\chrome\chrome.exe", Sha256 = new string('0', 64) },
                new LabProgram { Path = @"C:\NetworkLab\chrome\helper.exe", Sha256 = new string('1', 64) }],
            Groups = [new LabGroup { Id = "a", ProxyPath = @"C:\NetworkLab\a\mihomo.exe", ListenerPort = 23001,
                ProxySha256 = new string('2', 64),
                Address = "192.0.2.1", Port = 443, Protocol = "tcp" }] };
        sample.Validate(false);
        if (sample.Key("a") != sample.Key("a") || sample.Key("a") == sample.Key("b")) throw new Exception("Unstable keys");
        foreach (var invalid in new[] { sample with { ChromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe" },
            sample with { Groups = [sample.Groups[0], sample.Groups[0]] },
            sample with { ChromePrograms = [] },
            sample with { ChromePrograms = [sample.ChromePrograms[1]] },
            sample with { ChromePrograms = [sample.ChromePrograms[0], sample.ChromePrograms[0]] },
            sample with { ChromePrograms = [sample.ChromePrograms[0] with { Sha256 = "invalid" }] },
            sample with { Groups = [sample.Groups[0] with { Address = "node.example" }] } })
        {
            var rejected = false;
            try { invalid.Validate(false); } catch (ArgumentException) { rejected = true; }
            if (!rejected) throw new Exception("Unsafe policy accepted");
        }
        if (sample.ProtectedPrograms().Count() != 3 || sample.ProtectedPrograms().Select(program => program.Label).Distinct().Count() != 3)
            throw new Exception("Helper executable protection missing");
        PreflightTests.Run();
        RuntimeInventoryTests.Run();
        Console.WriteLine("{\"event\":\"selftest-passed\",\"wfpModified\":false,\"productionReady\":false}");
        return 0;
    }
    if (args is ["manifest", var directory])
    {
        Console.WriteLine(JsonSerializer.Serialize(LabProgram.CreateManifest(directory), LabJson.Default.LabProgramArray)); return 0;
    }
    if (args is ["runtime-manifest", var runtimeDirectory])
    {
        Console.WriteLine(JsonSerializer.Serialize(RuntimeInventory.ReadChrome(runtimeDirectory), RuntimeJson.Default.ChromeManifest)); return 0;
    }
    if (args is ["runtime-report", var reportDirectory])
    {
        var root = RuntimeInventory.CheckedDirectory(reportDirectory);
        var observation = new RuntimeObservation("runtime_inventory_observation", root, RuntimeInventory.ReadChrome(root));
        Console.WriteLine(JsonSerializer.Serialize(observation, RuntimeJson.Default.RuntimeObservation)); return 0;
    }
    if (args is ["runtime-verify", var verifyDirectory, var manifestFile])
    {
        var expected = JsonSerializer.Deserialize(File.ReadAllText(manifestFile), RuntimeJson.Default.ChromeManifest)
            ?? throw new ArgumentException("Empty runtime manifest");
        RuntimeInventory.Verify(RuntimeInventory.ReadChrome(verifyDirectory), expected);
        Console.WriteLine("{\"event\":\"runtime-matches-manifest\",\"wfpModified\":false,\"productionReady\":false}"); return 0;
    }
    if (args is ["runtime-space", var targetDirectory])
    {
        Console.WriteLine(JsonSerializer.Serialize(RuntimeInventory.ReadSpace(targetDirectory), RuntimeJson.Default.RuntimeSpace)); return 0;
    }
    if (args is ["ports"])
    {
        var inventory = PortPreflight.Read();
        Console.WriteLine($"{{\"event\":\"port-inventory-read\",\"dynamicRanges\":{inventory.Dynamic.Length},\"excludedRanges\":{inventory.Excluded.Length},\"occupiedPorts\":{inventory.Occupied.Count},\"wfpModified\":false}}"); return 0;
    }
    if (args.Length < 2 || args[0] is not ("validate" or "preflight" or "inspect" or "run" or "cleanup"))
    {
        Console.Error.WriteLine("LAB ONLY: selftest | ports | manifest/runtime-manifest/runtime-report <chrome-directory> | runtime-verify <directory> <manifest.json> | runtime-space <existing-directory> | validate/preflight/inspect <policy.json> | run <policy.json> --isolated-lab | cleanup <policy.json> --isolated-lab --processes-stopped");
        return 2;
    }
    var command = args[0];
    var policy = JsonSerializer.Deserialize(File.ReadAllText(args[1]), LabJson.Default.LabPolicy)
        ?? throw new ArgumentException("Empty policy");
    // Cleanup must work using the immutable manifest even if runtime files were
    // removed or changed after a crash; it never recomputes keys from disk.
    policy.Validate(files: command is "run" or "preflight");
    if (command == "validate")
    {
        Console.WriteLine("{\"event\":\"policy-valid\",\"wfpModified\":false,\"productionReady\":false}"); return 0;
    }
    if (command is "run" or "cleanup" && !args.Contains("--isolated-lab", StringComparer.Ordinal))
        throw new ArgumentException("Mutating commands require --isolated-lab on a dedicated Windows test machine");
    if (command is "run" or "cleanup" && (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000)
        || System.Runtime.InteropServices.RuntimeInformation.OSArchitecture != System.Runtime.InteropServices.Architecture.X64))
        throw new ArgumentException("Mutating commands require Windows 11 x64");
    if (command == "cleanup" && !args.Contains("--processes-stopped", StringComparer.Ordinal))
        throw new ArgumentException("Cleanup requires --processes-stopped after proving lab process termination");
    if (command is "run" or "preflight") PortPreflight.Read().Check(policy.Groups.Select(group => group.ListenerPort));
    if (command == "preflight")
    {
        Console.WriteLine("{\"event\":\"preflight-passed\",\"wfpModified\":false,\"productionReady\":false}"); return 0;
    }
    using var lab = new WfpLab(policy);
    if (command == "inspect")
    {
        var state = lab.Inspect();
        Console.WriteLine($"{{\"event\":\"inspection\",\"present\":{state.Present},\"expected\":{state.Expected},\"productionReady\":false}}");
        return 0;
    }
    if (command == "cleanup") { lab.Cleanup(); Console.WriteLine("{\"event\":\"lab-cleaned\"}"); return 0; }
    lab.Install();
    Console.WriteLine("{\"event\":\"installed-blocked\",\"productionReady\":false}");
    string? line;
    while ((line = Console.ReadLine()) != null)
    {
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts is ["activate", var id]) { lab.Activate(id); Console.WriteLine("{\"event\":\"lab-permission-active\"}"); }
        else if (parts is ["freeze", var group]) { lab.Freeze(group); Console.WriteLine("{\"event\":\"freeze-committed\"}"); }
        else if (parts is ["freeze-all"]) { lab.Freeze(null); Console.WriteLine("{\"event\":\"freeze-committed\"}"); }
        else if (parts is ["quit"]) break;
        else throw new ArgumentException("Unknown lab command");
    }
    Console.WriteLine("{\"event\":\"dynamic-session-closing\",\"durableDenyRetained\":true}");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message); return 1;
}
