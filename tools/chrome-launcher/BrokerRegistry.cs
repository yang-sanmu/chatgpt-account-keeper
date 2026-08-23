using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace GptAccountKeeper.ChromeLauncher;

internal sealed class RunEntry : IDisposable
{
    public required string RunToken { get; init; }
    public required SafeJobHandle Job { get; init; }
    public required SafeProcessHandle RootProcess { get; init; }
    public required int RootPid { get; init; }
    public required long RootStartTime { get; init; }

    public void Dispose()
    {
        Job.Dispose();
        RootProcess.Dispose();
    }
}

/// <summary>
/// Records a token whose job has already been disposed. Retained so that a lost
/// dispose ack can still be answered with a definitive "already disposed" instead of
/// UNKNOWN_TOKEN — without it, a dropped response would strand the account in
/// quarantine forever even though Chrome was actually reclaimed.
/// </summary>
internal readonly record struct Tombstone(string RunToken, int RootPid, long RootStartTime, DateTimeOffset DisposedAt);

internal sealed class BrokerRegistry
{
    /// <summary>
    /// Hard cap. On overflow the broker refuses new launches (fail-closed) rather than
    /// evicting a tombstone that an Agent may still reference: dropping idempotency is
    /// worse than refusing work, because it re-creates the permanent-quarantine bug.
    /// </summary>
    public const int MaxTombstones = 4096;

    private readonly Dictionary<string, RunEntry> _active = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Tombstone> _tombstones = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public int ActiveCount { get { lock (_gate) return _active.Count; } }

    public int TombstoneCount { get { lock (_gate) return _tombstones.Count; } }

    public bool TryGetActive(string token, out RunEntry entry)
    {
        lock (_gate) return _active.TryGetValue(token, out entry!);
    }

    public bool IsTombstoned(string token)
    {
        lock (_gate) return _tombstones.ContainsKey(token);
    }

    public bool KnowsToken(string token)
    {
        lock (_gate) return _active.ContainsKey(token) || _tombstones.ContainsKey(token);
    }

    public void AddActive(RunEntry entry)
    {
        lock (_gate) _active.Add(entry.RunToken, entry);
    }

    public bool TombstoneCapacityAvailable
    {
        get { lock (_gate) return _tombstones.Count < MaxTombstones; }
    }

    /// <summary>
    /// Closes the OS handles first, then removes the active entry and records the
    /// tombstone — all before the caller reports success. Ordering matters: the
    /// tombstone must exist before the ack leaves the process, otherwise a crash
    /// between the two would lose the only proof the run was reclaimed.
    /// </summary>
    public void Dispose(string token)
    {
        lock (_gate)
        {
            if (!_active.TryGetValue(token, out var entry)) return;
            var tombstone = new Tombstone(token, entry.RootPid, entry.RootStartTime, DateTimeOffset.UtcNow);
            entry.Dispose();
            _active.Remove(token);
            _tombstones[token] = tombstone;
        }
    }

    public void Forget(string token)
    {
        lock (_gate) _tombstones.Remove(token);
    }

    public void ForgetAllTombstones()
    {
        lock (_gate) _tombstones.Clear();
    }

    public List<RunEntry> SnapshotActive()
    {
        lock (_gate) return _active.Values.ToList();
    }

    /// <summary>
    /// Emergency path: release every job handle so KILL_ON_JOB_CLOSE reclaims all
    /// Chrome trees. Used on stdin EOF, which is how a killed Agent is detected.
    /// </summary>
    public void DisposeAllHandles()
    {
        lock (_gate)
        {
            foreach (var entry in _active.Values) entry.Dispose();
            _active.Clear();
        }
    }
}

internal static class ChromeStarter
{
    /// <summary>
    /// Creation-time containment. AssignProcessToJobObject is not retroactive, and
    /// Chrome spawns crashpad/gpu/renderer within its first few hundred milliseconds,
    /// so a post-spawn assign provably leaks descendants. PROC_THREAD_ATTRIBUTE_JOB_LIST
    /// places the process in the job at creation, leaving no window at all.
    /// </summary>
    public static (int pid, long startTime, SafeProcessHandle process) Launch(
        SafeJobHandle job,
        string executable,
        IReadOnlyList<string> args,
        string? workingDirectory)
    {
        using var attributes = ProcThreadAttributeList.ForJob(job);
        var startupInfo = new Win32.StartupInfoEx();
        startupInfo.StartupInfo.cb = Marshal.SizeOf<Win32.StartupInfoEx>();
        startupInfo.lpAttributeList = attributes.Handle;

        var flags = Win32.ExtendedStartupInfoPresent | Win32.CreateUnicodeEnvironment;
        // CreateProcessW is documented to be able to modify lpCommandLine in place, so
        // it gets its own writable native buffer.
        var commandLine = Marshal.StringToHGlobalUni(BuildCommandLine(executable, args));
        Win32.ProcessInformation info;
        try
        {
            if (!Win32.CreateProcess(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    flags,
                    IntPtr.Zero,
                    string.IsNullOrWhiteSpace(workingDirectory) ? null : workingDirectory,
                    ref startupInfo,
                    out info))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(commandLine);
        }

        var process = new SafeProcessHandle(info.hProcess);
        using var thread = new SafeThreadHandle(info.hThread);
        if (!Win32.GetProcessTimes(process, out var creation, out _, out _, out _))
        {
            var error = Marshal.GetLastWin32Error();
            Win32.TerminateProcess(process, 1);
            process.Dispose();
            throw new Win32Exception(error, "GetProcessTimes failed");
        }

        // Verify containment actually took effect rather than trusting the flag.
        if (!Win32.IsProcessInJob(process, job, out var inJob) || !inJob)
        {
            Win32.TerminateProcess(process, 1);
            process.Dispose();
            throw new InvalidOperationException("created process is not in the per-run job");
        }

        return (info.dwProcessId, creation, process);
    }

    /// <summary>
    /// Windows command-line quoting per CommandLineToArgvW. Chrome arguments routinely
    /// contain spaces (profile paths), so naive joining would silently split them.
    /// </summary>
    public static string BuildCommandLine(string executable, IReadOnlyList<string> args)
    {
        var builder = new StringBuilder();
        AppendQuoted(builder, executable);
        foreach (var arg in args)
        {
            builder.Append(' ');
            AppendQuoted(builder, arg);
        }
        return builder.ToString();
    }

    private static void AppendQuoted(StringBuilder builder, string value)
    {
        if (value.Length > 0 && value.IndexOfAny([' ', '\t', '"', '\n', '\v']) < 0)
        {
            builder.Append(value);
            return;
        }
        builder.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var backslashes = 0;
            while (i < value.Length && value[i] == '\\')
            {
                backslashes++;
                i++;
            }
            if (i == value.Length)
            {
                builder.Append('\\', backslashes * 2);
                break;
            }
            if (value[i] == '"')
            {
                builder.Append('\\', (backslashes * 2) + 1);
            }
            else
            {
                builder.Append('\\', backslashes);
            }
            builder.Append(value[i]);
        }
        builder.Append('"');
    }
}
