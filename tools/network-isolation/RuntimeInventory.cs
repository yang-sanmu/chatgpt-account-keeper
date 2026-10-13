using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace GptAccountKeeper.NetworkIsolation;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record RuntimeFile(string RelativePath, long SizeBytes, string Sha256);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ChromeManifest(string Version, RuntimeFile[] Files);
internal sealed record RuntimeSpace(string Directory, long AvailableBytes, bool ProductionReady = false);
internal sealed record RuntimeObservation(string Kind, string Directory, ChromeManifest Manifest);
internal sealed record ProgramObservation(string Kind, string Path, long SizeBytes, string Sha256,
    DateTimeOffset ObservedAt, bool ProductionReady = false);

// Read-only NTFS snapshot. No ACL/signature verification, copying, or launch authority.
internal static partial class RuntimeInventory
{
    internal sealed record Snapshot(string Root, RuntimeFile[] Files,
        Dictionary<string, FileStamp> Stamps, Dictionary<string, DirectoryStamp> Directories);
    internal readonly record struct DirectoryStamp(FileAttributes Attributes, long Creation, long LastWrite);
    internal readonly record struct FileStamp(uint Attributes, long Creation, long LastWrite,
        uint Volume, ulong Index, long Size, uint Links);

    internal static string CheckedDirectory(string directory)
    {
        var root = CheckedPath(directory);
        if (root == Path.GetPathRoot(root)) throw new ArgumentException("Do not scan a whole volume");
        if (!Directory.Exists(root)) throw new ArgumentException("Runtime directory missing");
        return root;
    }

    private static string CheckedPath(string value)
    {
        if (!Path.IsPathFullyQualified(value) || !Regex.IsMatch(value, @"^[a-zA-Z]:\\") || value.AsSpan(2).Contains(':'))
            throw new ArgumentException("Runtime path must be a local drive path without alternate data streams");
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        CheckAncestors(root);
        // The 64-bit file index used below is not a unique identity on ReFS.
        if (!string.Equals(new DriveInfo(Path.GetPathRoot(root)!).DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Runtime inventory prototype requires NTFS");
        return root;
    }

    private static void CheckAncestors(string file)
    {
        for (var current = file; current != null; current = Path.GetDirectoryName(current))
            RejectReparse(File.GetAttributes(current));
    }
    private static void RejectReparse(FileAttributes attributes)
    {
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("Runtime inventory refuses reparse points, including junctions");
    }

    private static (string[] Files, Dictionary<string, DirectoryStamp> Directories) Enumerate(string root)
    {
        CheckAncestors(root);
        var files = new List<string>();
        var directories = new Dictionary<string, DirectoryStamp>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>(); pending.Push(root);
        while (pending.TryPop(out var directory))
        {
            var info = new DirectoryInfo(directory);
            RejectReparse(info.Attributes);
            directories.Add(directory, new(info.Attributes, info.CreationTimeUtc.Ticks, info.LastWriteTimeUtc.Ticks));
            foreach (var item in Directory.EnumerateFileSystemEntries(directory))
            {
                var attributes = File.GetAttributes(item); RejectReparse(attributes);
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(item);
                else files.Add(item);
                if (files.Count + directories.Count + pending.Count > 100000)
                    throw new ArgumentException("Runtime inventory exceeds 100000 entries");
            }
        }
        return (files.Order(StringComparer.OrdinalIgnoreCase).ToArray(), directories);
    }

    private static FileStream Open(string file)
    {
        RejectReparse(File.GetAttributes(file));
        return new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
    }
    private static FileStamp Stamp(FileStream stream)
    {
        if (GetFileInformationByHandle(stream.SafeFileHandle, out var info) == 0)
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        RejectReparse((FileAttributes)info.Attributes);
        if (info.Links != 1) throw new ArgumentException("Runtime inventory refuses hard-linked files");
        return new(info.Attributes, CombineTime(info.CreationHigh, info.CreationLow), CombineTime(info.WriteHigh, info.WriteLow),
            info.Volume, ((ulong)info.IndexHigh << 32) | info.IndexLow, checked((long)(((ulong)info.SizeHigh << 32) | info.SizeLow)), info.Links);
    }
    private static long CombineTime(uint high, uint low) => unchecked((long)(((ulong)high << 32) | low));

    internal static Snapshot Capture(string directory)
    {
        var root = CheckedDirectory(directory);
        var tree = Enumerate(root);
        var files = new List<RuntimeFile>();
        var stamps = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in tree.Files)
        {
            using var stream = Open(file);
            var before = Stamp(stream);
            var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            if (before != Stamp(stream)) throw new ArgumentException("Runtime changed while hashing");
            stamps.Add(file, before);
            files.Add(new(Path.GetRelativePath(root, file), before.Size, hash));
        }
        return new(root, files.ToArray(), stamps, tree.Directories);
    }

    internal static void AssertUnchanged(Snapshot snapshot)
    {
        var current = Enumerate(snapshot.Root);
        if (current.Files.Length != snapshot.Stamps.Count || current.Directories.Count != snapshot.Directories.Count
            || current.Directories.Any(item => !snapshot.Directories.TryGetValue(item.Key, out var previous) || previous != item.Value))
            throw new ArgumentException("Runtime directory changed during inspection");
        foreach (var file in current.Files)
        {
            using var stream = Open(file);
            if (!snapshot.Stamps.TryGetValue(file, out var previous) || previous != Stamp(stream))
                throw new ArgumentException("Runtime file changed during inspection");
        }
    }

    internal static ChromeManifest ReadChrome(string directory)
    {
        var snapshot = Capture(directory);
        if (!snapshot.Files.Any(file => string.Equals(file.RelativePath, "chrome.exe", StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException("Runtime root must contain chrome.exe");
        var version = FileVersionInfo.GetVersionInfo(Path.Combine(snapshot.Root, "chrome.exe")).FileVersion;
        if (version == null || !Regex.IsMatch(version, @"^\d+\.\d+\.\d+\.\d+$"))
            throw new ArgumentException("Cannot read Chrome file version");
        AssertUnchanged(snapshot);
        return new(version, snapshot.Files);
    }

    internal static ProgramObservation ReadProgram(string file)
    {
        var path = CheckedPath(file);
        using var stream = Open(path);
        var before = Stamp(stream);
        var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (before != Stamp(stream)) throw new ArgumentException("Program changed while hashing");
        // Retain the read handle while checking that the path still names this file.
        CheckAncestors(path);
        using var current = Open(path);
        if (before != Stamp(current)) throw new ArgumentException("Program path changed during inspection");
        return new("program_file_observation", path, before.Size, hash, DateTimeOffset.UtcNow);
    }

    internal static void Verify(ChromeManifest actual, ChromeManifest expected)
    {
        // Expected paths are never opened; compare against a fresh complete scan.
        if (actual.Version != expected.Version || expected.Files == null || actual.Files.Length != expected.Files.Length)
            throw new ArgumentException("Runtime version or file count differs from manifest");
        var files = actual.Files.ToDictionary(file => file.RelativePath, StringComparer.OrdinalIgnoreCase);
        foreach (var file in expected.Files)
        {
            if (file == null || !files.Remove(file.RelativePath, out var found)
                || found.SizeBytes != file.SizeBytes || found.Sha256 != file.Sha256)
                throw new ArgumentException("Runtime contents differ from manifest");
        }
    }

    internal static RuntimeSpace ReadSpace(string directory)
    {
        var root = CheckedDirectory(directory);
        return new(root, new DriveInfo(Path.GetPathRoot(root)!).AvailableFreeSpace);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial int GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(ChromeManifest))]
[JsonSerializable(typeof(RuntimeSpace))]
[JsonSerializable(typeof(RuntimeObservation))]
[JsonSerializable(typeof(ProgramObservation))]
[JsonSerializable(typeof(PortObservation))]
internal partial class RuntimeJson : JsonSerializerContext { }
