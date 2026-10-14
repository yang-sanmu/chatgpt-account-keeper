using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GptAccountKeeper.NetworkIsolation;

internal sealed record V4LabReport(string Event, Guid RunId, bool WfpModified,
    V4Observation[]? Objects = null, bool ProductionReady = false, string LaunchAuthorization = "not_issued");

internal static class V4LabCommands
{
    private static void Report(string name, V4LabReceipt receipt, bool modified, V4Observation[]? objects = null) =>
        Console.WriteLine(JsonSerializer.Serialize(new V4LabReport(name, receipt.RunId, modified, objects), V4ReportJson.Default.V4LabReport));

    internal static int Run(string[] args)
    {
        if (args is ["v4-prepare", var resourcesFile, var root, var output])
        {
            using var input = JsonDocument.Parse(File.ReadAllText(resourcesFile));
            var prepared = V4LabReceipt.Prepare(input.RootElement, root);
            // No WFP mutation before a complete, durable, create-new receipt exists.
            using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, prepared, V4ReceiptJson.Default.V4LabReceipt); stream.Flush(true);
            }
            Report("receipt-prepared", prepared, false); return 0;
        }
        var valid = args is ["v4-test", _] or ["v4-inspect", _]
            or ["v4-run", _, "--isolated-lab"]
            or ["v4-cleanup", _, "--isolated-lab", "--processes-stopped", "--resources-retired"];
        if (!valid) throw new ArgumentException("v4-prepare <resources.json> <labRoot> <new-receipt.json> | v4-test/v4-inspect <receipt.json> | v4-run <receipt.json> --isolated-lab | v4-cleanup <receipt.json> --isolated-lab --processes-stopped --resources-retired");
        var command = args[0];
        var receipt = JsonSerializer.Deserialize(File.ReadAllText(args[1]), V4ReceiptJson.Default.V4LabReceipt)
            ?? throw new ArgumentException("Empty v4 lab receipt");
        receipt.Validate();
        if (command == "v4-test")
        {
            V4LabLifecycleTests.Run(receipt); Report("offline-lifecycle-tests-passed", receipt, false); return 0;
        }
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000) || RuntimeInformation.OSArchitecture != Architecture.X64)
            throw new ArgumentException("Native v4 lab commands require Windows 11 x64");
        // A sidecar lock serializes this receipt's owner and cleanup process. It is
        // intentionally retained: unlinking a lock file would let two owners in.
        using var receiptLock = command == "v4-inspect" ? null
            : new FileStream(args[1] + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        if (command == "v4-run") receipt.CheckFilesAndPorts();
        using var store = new NativeV4LabStore(receipt);
        var lab = new V4LabLifecycle(receipt, store);
        if (command == "v4-inspect") { Report("inspection", receipt, false, lab.Inspect()); return 0; }
        if (command == "v4-cleanup") { lab.Cleanup(); Report("receipt-resources-cleaned", receipt, true); return 0; }
        lab.Install(); Report("default-denials-committed", receipt, true);
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts is ["listen", var group]) { lab.Listen(group); Report("support-permissions-committed", receipt, true); }
            else if (parts is ["activate", var active]) { lab.Activate(active); Report("business-permissions-committed", receipt, true); }
            else if (parts is ["freeze", var frozen]) { lab.Freeze(frozen); Report("business-permissions-removed", receipt, true); }
            else if (parts is ["freeze-all"]) { lab.Freeze(null); Report("business-permissions-removed", receipt, true); }
            else if (parts is ["inspect"]) Report("inspection", receipt, false, lab.Inspect());
            else if (parts is ["quit"]) break;
            else throw new ArgumentException("Expected listen/activate/freeze <group-key>, freeze-all, inspect or quit");
        }
        // Dynamic permissions disappear on close; persistent denials require
        // explicit cleanup after the operator proves processes/resources retired.
        Report("dynamic-session-closing-denials-retained", receipt, true); return 0;
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(V4LabReport))]
internal partial class V4ReportJson : JsonSerializerContext { }
