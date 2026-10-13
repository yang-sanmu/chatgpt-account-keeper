using System.Security.Cryptography;

namespace GptAccountKeeper.NetworkIsolation;

internal static class RuntimeInventoryTests
{
    private static void Reject(System.Action action)
    {
        try { action(); } catch (ArgumentException) { return; }
        throw new Exception("Changed runtime accepted");
    }
    internal static void Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "keeper-runtime-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var main = Path.Combine(root, "chrome.exe"); File.WriteAllText(main, "synthetic main");
            var resource = Path.Combine(root, "resources.pak"); File.WriteAllText(resource, "resource bytes");
            var snapshot = RuntimeInventory.Capture(root); RuntimeInventory.AssertUnchanged(snapshot);
            var manifest = new ChromeManifest("1.0.0.0", snapshot.Files);
            RuntimeInventory.Verify(manifest, manifest with { Files = snapshot.Files.Reverse().ToArray() });
            if (snapshot.Files.Single(file => file.RelativePath == "resources.pak").Sha256
                != Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(resource))).ToLowerInvariant())
                throw new Exception("Resource hash mismatch");
            Reject(() => RuntimeInventory.Verify(manifest, manifest with { Version = "2.0.0.0" }));
            Reject(() => RuntimeInventory.Verify(manifest, manifest with { Files = [snapshot.Files[0]] }));
            Reject(() => RuntimeInventory.Verify(manifest, manifest with { Files = [snapshot.Files[0], snapshot.Files[0]] }));
            Reject(() => RuntimeInventory.Verify(manifest, manifest with { Files = [snapshot.Files[0] with { Sha256 = new string('0', 64) }, snapshot.Files[1]] }));

            // Non-executable resources count, including same-length content changes.
            File.WriteAllText(resource, "different text");
            Reject(() => RuntimeInventory.AssertUnchanged(snapshot));
            var changed = RuntimeInventory.Capture(root);
            Reject(() => RuntimeInventory.Verify(new(manifest.Version, changed.Files), manifest));
            var extra = Path.Combine(root, "new.dll"); File.WriteAllText(extra, "extra");
            Reject(() => RuntimeInventory.AssertUnchanged(changed)); File.Delete(extra);
            var beforeRemoval = RuntimeInventory.Capture(root); File.Delete(resource);
            Reject(() => RuntimeInventory.AssertUnchanged(beforeRemoval));
            var beforeRename = RuntimeInventory.Capture(root); File.Move(main, Path.Combine(root, "renamed.exe"));
            Reject(() => RuntimeInventory.AssertUnchanged(beforeRename));
            if (RuntimeInventory.ReadSpace(root).AvailableBytes < 0) throw new Exception("Invalid space query");
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(root)) != Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar))
                throw new Exception("Unsafe runtime test cleanup path");
            Directory.Delete(root, true);
        }
    }
}
