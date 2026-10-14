using System.Security.AccessControl;
using System.Text.Json.Serialization;

namespace GptAccountKeeper.NetworkIsolation;

internal sealed record AclFinding(string Code, string? Sid = null, int? AceIndex = null);
internal sealed record AclObservationEntry(string Path, string Scope, string? OwnerSid, string Sddl, AclFinding[] Findings);
internal sealed record RuntimeAclObservation(string Kind, string Directory, DateTimeOffset ObservedAt,
    string Status, AclObservationEntry[] Entries, bool EffectiveAccessChecked = false,
    bool AclModified = false, bool ProductionReady = false, string LaunchAuthorization = "not_issued");

// A read-only audit of ordinary installation ACLs, not an AccessCheck/token emulator.
// Unknown owners/writers and complex ACEs require review, never an automatic repair.
internal static class RuntimeAcl
{
    private const AccessControlSections Sections = AccessControlSections.Owner | AccessControlSections.Access;
    internal const string TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    private static bool IsSystemWriter(string? sid) => sid is "S-1-5-18" or "S-1-5-32-544" or TrustedInstaller;

    internal static AclObservationEntry Inspect(string path, string scope, RawSecurityDescriptor descriptor)
    {
        var findings = new List<AclFinding>();
        var owner = descriptor.Owner?.Value;
        if (!IsSystemWriter(owner)) findings.Add(new("owner_requires_review", owner));
        var dacl = descriptor.DiscretionaryAcl;
        if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || dacl == null)
            findings.Add(new("unrestricted_dacl"));
        else
        {
            // Tree: content writes/additions, metadata writes, deletion and ACL/owner changes.
            // Ancestors: deletion/replacement of existing descendants or changing their boundary.
            // Creating unrelated siblings alone does not make the installed tree writable.
            var mutationMask = scope == "ancestor" ? 0x000D0040u : 0x000D0156u;
            for (var i = 0; i < dacl.Count; i++)
            {
                var ace = dacl[i];
                if ((ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
                if (ace is not CommonAce common || common.IsCallback
                    || common.AceQualifier is not (AceQualifier.AccessAllowed or AceQualifier.AccessDenied))
                {
                    findings.Add(new("unsupported_ace", AceIndex: i)); continue;
                }
                if (common.AceQualifier == AceQualifier.AccessDenied) continue;
                var mask = unchecked((uint)common.AccessMask);
                if ((mask & 0x10000000u) != 0) mask |= 0x001F01FFu; // GENERIC_ALL -> FILE_ALL_ACCESS
                if ((mask & 0x40000000u) != 0) mask |= 0x00120116u; // GENERIC_WRITE -> FILE_GENERIC_WRITE
                if ((mask & mutationMask) != 0 && !IsSystemWriter(common.SecurityIdentifier.Value))
                    findings.Add(new("write_grant_requires_review", common.SecurityIdentifier.Value, i));
            }
        }
        // A deny ACE is not subtracted from allows: effective access needs a real token.
        return new(path, scope, owner, descriptor.GetSddlForm(Sections), findings.ToArray());
    }

    private static RawSecurityDescriptor ReadDescriptor(string path, bool directory)
    {
        FileSystemSecurity security = directory
            ? new DirectoryInfo(path).GetAccessControl(Sections)
            : new FileInfo(path).GetAccessControl(Sections);
        return new(security.GetSecurityDescriptorBinaryForm(), 0);
    }

    internal static RuntimeAclObservation Read(string directory)
    {
        // Reuse the complete NTFS inventory, link checks and change detection.
        var snapshot = RuntimeInventory.Capture(directory);
        var targets = snapshot.Directories.Keys.Select(path => (Path: path, Scope: "directory"))
            .Concat(snapshot.Stamps.Keys.Select(path => (Path: path, Scope: "file"))).ToList();
        for (var parent = Path.GetDirectoryName(snapshot.Root); parent != null; parent = Path.GetDirectoryName(parent))
            targets.Add((parent, "ancestor"));
        var entries = targets.OrderBy(target => target.Path, StringComparer.OrdinalIgnoreCase)
            .Select(target => Inspect(target.Path, target.Scope, ReadDescriptor(target.Path, target.Scope != "file"))).ToArray();
        RuntimeInventory.AssertUnchanged(snapshot);
        foreach (var entry in entries)
        {
            if (ReadDescriptor(entry.Path, entry.Scope != "file").GetSddlForm(Sections) != entry.Sddl)
                throw new ArgumentException("Runtime ACL changed during inspection");
        }
        return new("runtime_acl_observation", snapshot.Root, DateTimeOffset.UtcNow,
            entries.Any(entry => entry.Findings.Length != 0) ? "review_required" : "no_obvious_write_grants", entries);
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(RuntimeAclObservation))]
internal partial class AclJson : JsonSerializerContext { }
