using System.Security.AccessControl;
using System.Security.Principal;

namespace GptAccountKeeper.NetworkIsolation;

internal static class RuntimeAclTests
{
    private static AclFinding[] Findings(string sddl, string scope = "directory") =>
        RuntimeAcl.Inspect(@"C:\Synthetic", scope, new RawSecurityDescriptor(sddl)).Findings;

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    internal static void Run()
    {
        const string safe = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)";
        Require(Findings(safe).Length == 0, "Read-only users flagged as writers");
        Require(Findings($"O:{RuntimeAcl.TrustedInstaller}D:(A;;FA;;;{RuntimeAcl.TrustedInstaller})").Length == 0,
            "TrustedInstaller ownership incorrectly rejected");
        Require(Findings("O:BUD:(A;;GRGX;;;BU)").Any(f => f.Code == "owner_requires_review"), "Untrusted owner ignored");
        Require(Findings("O:BA").Any(f => f.Code == "unrestricted_dacl"), "Missing DACL accepted");
        var nullAcl = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent, new SecurityIdentifier("S-1-5-32-544"), null, null, null);
        Require(RuntimeAcl.Inspect(@"C:\Synthetic", "directory", nullAcl).Findings.Any(f => f.Code == "unrestricted_dacl"), "Null DACL accepted");
        Require(Findings("O:BAD:").Length == 0, "Empty DACL confused with null DACL");
        foreach (var rights in new[] { "GW", "GA", "0x2", "0x4", "0x10", "0x40", "0x100", "SD", "WD", "WO" })
            Require(Findings($"O:BAD:(A;;{rights};;;BU)").Any(f => f.Code == "write_grant_requires_review"), $"Missed write mask {rights}");
        Require(Findings("O:BAD:(A;OICIIO;GA;;;BU)").Length == 0, "Inherit-only ACE applies to current object");
        Require(Findings("O:BAD:(A;ID;GW;;;AU)").Any(f => f.Code == "write_grant_requires_review"), "Inherited writer ignored");
        Require(Findings("O:BAD:(D;;GA;;;BU)(A;;GA;;;BU)").Any(f => f.Code == "write_grant_requires_review"), "Allow removed without token evaluation");
        Require(Findings("O:BAD:(A;;0x4;;;BU)", "ancestor").Length == 0, "Unrelated sibling creation marked as replacement");
        foreach (var rights in new[] { "GA", "0x40", "SD", "WD", "WO" })
            Require(Findings($"O:BAD:(A;;{rights};;;BU)", "ancestor").Length > 0, $"Missed ancestor replacement right {rights}");
        var complex = new RawAcl(2, 1);
        complex.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 2, new SecurityIdentifier("S-1-1-0"), true, []));
        var conditional = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent, new SecurityIdentifier("S-1-5-32-544"), null, null, complex);
        Require(RuntimeAcl.Inspect(@"C:\Synthetic", "directory", conditional).Findings.Any(f => f.Code == "unsupported_ace"), "Callback ACE evaluated as ordinary allow");
    }
}
