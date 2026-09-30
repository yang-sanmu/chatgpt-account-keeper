using System.Text.Json;
using GptAccountKeeper.NetworkIsolation;

try
{
    NativeWfp.CheckLayout();
    if (args.Length == 1 && args[0] == "selftest")
    {
        var sample = new LabPolicy { Id = Guid.NewGuid(), LabRoot = @"C:\NetworkLab", ChromePath = @"C:\NetworkLab\chrome\chrome.exe",
            Groups = [new LabGroup { Id = "a", ProxyPath = @"C:\NetworkLab\a\mihomo.exe", ListenerPort = 23001,
                Address = "192.0.2.1", Port = 443, Protocol = "tcp" }] };
        sample.Validate(false);
        if (sample.Key("a") != sample.Key("a") || sample.Key("a") == sample.Key("b")) throw new Exception("Unstable keys");
        foreach (var invalid in new[] { sample with { ChromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe" },
            sample with { Groups = [sample.Groups[0], sample.Groups[0]] },
            sample with { Groups = [sample.Groups[0] with { Address = "node.example" }] } })
        {
            var rejected = false;
            try { invalid.Validate(false); } catch (ArgumentException) { rejected = true; }
            if (!rejected) throw new Exception("Unsafe policy accepted");
        }
        Console.WriteLine("{\"event\":\"selftest-passed\",\"wfpModified\":false,\"productionReady\":false}");
        return 0;
    }
    if (args.Length < 2 || args[0] is not ("validate" or "inspect" or "run" or "cleanup"))
    {
        Console.Error.WriteLine("LAB ONLY: selftest | validate <policy.json> | inspect <policy.json> | run <policy.json> --isolated-lab | cleanup <policy.json> --isolated-lab --processes-stopped");
        return 2;
    }
    var command = args[0];
    var policy = JsonSerializer.Deserialize(File.ReadAllText(args[1]), LabJson.Default.LabPolicy)
        ?? throw new ArgumentException("Empty policy");
    policy.Validate(files: command != "validate");
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
