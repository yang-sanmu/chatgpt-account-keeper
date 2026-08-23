using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace GptAccountKeeper.Desktop.Infrastructure.Agent;

internal sealed class SafeJobObjectHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeJobObjectHandle() : base(true) { }

    public SafeJobObjectHandle(IntPtr handle) : base(true) => SetHandle(handle);

    protected override bool ReleaseHandle() => WindowsJobNative.CloseHandle(handle);
}

internal sealed class SafeThreadObjectHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeThreadObjectHandle() : base(true) { }

    public SafeThreadObjectHandle(IntPtr handle) : base(true) => SetHandle(handle);

    protected override bool ReleaseHandle() => WindowsJobNative.CloseHandle(handle);
}

internal sealed class SafeProcessObjectHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeProcessObjectHandle() : base(true) { }

    public SafeProcessObjectHandle(IntPtr handle) : base(true) => SetHandle(handle);

    protected override bool ReleaseHandle() => WindowsJobNative.CloseHandle(handle);
}

internal sealed record AgentJobLaunch(Process Process, SafeJobObjectHandle Job, long GenerationId);

/// <summary>
/// Creates the Agent already inside its job.
///
/// Process.Start followed by AssignProcessToJobObject is NOT usable here:
/// AssignProcessToJobObject is not retroactive, and the Agent's first action is to spawn
/// the chrome-launcher broker. Measured locally, the broker then lands OUTSIDE the job
/// (agentInJob=true, brokerInJob=false) and survives TerminateJobObject on the outer job,
/// which would defeat the entire Desktop-crash backstop: the broker keeps every per-run
/// Job handle alive, so KILL_ON_JOB_CLOSE never fires and Chrome leaks.
///
/// PROC_THREAD_ATTRIBUTE_JOB_LIST places the process in the job at creation time, so the
/// window is zero rather than merely small.
/// </summary>
internal static class WindowsJobLauncher
{
    public static AgentJobLaunch Launch(ProcessStartInfo startInfo)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("WindowsJobLauncher requires Windows");
        }

        SafeJobObjectHandle? job = null;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobHandleStorage = IntPtr.Zero;
        var attributeListInitialized = false;
        SafeProcessObjectHandle? processHandle = null;
        SafeThreadObjectHandle? threadHandle = null;
        IntPtr commandLine = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;

        try
        {
            job = CreateKillOnCloseJob();

            var size = IntPtr.Zero;
            if (!WindowsJobNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size)
                && Marshal.GetLastWin32Error() != WindowsJobNative.ErrorInsufficientBuffer)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList sizing failed");
            }
            attributeList = Marshal.AllocHGlobal(size);
            if (!WindowsJobNative.InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
            }
            attributeListInitialized = true;

            // UpdateProcThreadAttribute stores a pointer, not a copy: the storage must
            // outlive CreateProcessW.
            jobHandleStorage = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobHandleStorage, job.DangerousGetHandle());
            if (!WindowsJobNative.UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    WindowsJobNative.ProcThreadAttributeJobList,
                    jobHandleStorage,
                    (IntPtr)IntPtr.Size,
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute(JOB_LIST) failed");
            }

            var startupInfo = new WindowsJobNative.StartupInfoEx();
            startupInfo.StartupInfo.cb = Marshal.SizeOf<WindowsJobNative.StartupInfoEx>();
            startupInfo.lpAttributeList = attributeList;

            commandLine = Marshal.StringToHGlobalUni(BuildCommandLine(startInfo));
            environmentBlock = BuildEnvironmentBlock(startInfo);

            var flags = WindowsJobNative.ExtendedStartupInfoPresent
                | WindowsJobNative.CreateUnicodeEnvironment
                | (startInfo.CreateNoWindow ? WindowsJobNative.CreateNoWindow : 0u);

            if (!WindowsJobNative.CreateProcess(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    flags,
                    environmentBlock,
                    string.IsNullOrWhiteSpace(startInfo.WorkingDirectory) ? null : startInfo.WorkingDirectory,
                    ref startupInfo,
                    out var info))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            }
            processHandle = new SafeProcessObjectHandle(info.hProcess);
            threadHandle = new SafeThreadObjectHandle(info.hThread);

            // Verify containment instead of trusting the flag: a silent miss here is the
            // exact failure that leaves an unprotected Agent running.
            if (!WindowsJobNative.IsProcessInJob(processHandle, job, out var inJob) || !inJob)
            {
                WindowsJobNative.TerminateProcess(processHandle, 1);
                throw new InvalidOperationException("created Agent is not inside the Agent-level job");
            }

            var process = Process.GetProcessById(info.dwProcessId);
            var generationId = Interlocked.Increment(ref _generation);
            var launched = new AgentJobLaunch(process, job, generationId);
            job = null; // ownership transferred to the caller
            return launched;
        }
        catch
        {
            // fail-closed: never hand back a process that is not provably contained.
            if (processHandle is { IsInvalid: false })
            {
                try { WindowsJobNative.TerminateProcess(processHandle, 1); } catch { /* already gone */ }
            }
            job?.Dispose();
            throw;
        }
        finally
        {
            threadHandle?.Dispose();
            processHandle?.Dispose();
            if (attributeListInitialized) WindowsJobNative.DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (jobHandleStorage != IntPtr.Zero) Marshal.FreeHGlobal(jobHandleStorage);
            if (commandLine != IntPtr.Zero) Marshal.FreeHGlobal(commandLine);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        }
    }

    private static long _generation;

    private static SafeJobObjectHandle CreateKillOnCloseJob()
    {
        var raw = WindowsJobNative.CreateJobObject(IntPtr.Zero, null);
        if (raw == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }
        var job = new SafeJobObjectHandle(raw);
        // The limit must be armed BEFORE any process joins, otherwise there is a window
        // where a member exists but KILL_ON_JOB_CLOSE is not yet in effect.
        var info = new WindowsJobNative.JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new WindowsJobNative.JobObjectBasicLimitInformation
            {
                LimitFlags = WindowsJobNative.JobObjectLimitKillOnJobClose,
            },
        };
        var size = Marshal.SizeOf<WindowsJobNative.JobObjectExtendedLimitInformation>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!WindowsJobNative.SetInformationJobObject(
                    job,
                    WindowsJobNative.JobObjectExtendedLimitInformationClass,
                    buffer,
                    (uint)size))
            {
                var error = Marshal.GetLastWin32Error();
                job.Dispose();
                throw new Win32Exception(error, "SetInformationJobObject(KILL_ON_JOB_CLOSE) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    /// <summary>
    /// Rebuilds the ArgumentList as a single command line using CommandLineToArgvW
    /// quoting. Data-root and executable paths routinely contain spaces, so naive
    /// joining would split one argument into two.
    /// </summary>
    public static string BuildCommandLine(ProcessStartInfo startInfo)
    {
        var builder = new StringBuilder();
        AppendArgument(builder, startInfo.FileName);
        foreach (var argument in startInfo.ArgumentList)
        {
            builder.Append(' ');
            AppendArgument(builder, argument);
        }
        return builder.ToString();
    }

    public static void AppendArgument(StringBuilder builder, string value)
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

    /// <summary>
    /// Unicode environment block: NAME=VALUE pairs, each NUL-terminated, block ends with
    /// an extra NUL. ProcessStartInfo.Environment starts from the parent environment, so
    /// this preserves inherited variables plus the explicit overrides.
    /// </summary>
    public static IntPtr BuildEnvironmentBlock(ProcessStartInfo startInfo)
    {
        var builder = new StringBuilder();
        foreach (var pair in startInfo.Environment)
        {
            if (pair.Value is null) continue;
            builder.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        }
        builder.Append('\0');
        return Marshal.StringToHGlobalUni(builder.ToString());
    }
}

internal static partial class WindowsJobNative
{
    public const int ErrorInsufficientBuffer = 122;
    public const uint ExtendedStartupInfoPresent = 0x00080000;
    public const uint CreateNoWindow = 0x08000000;
    public const uint CreateUnicodeEnvironment = 0x00000400;
    public static readonly IntPtr ProcThreadAttributeJobList = (IntPtr)0x0002000D;
    public const int JobObjectExtendedLimitInformationClass = 9;
    public const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    public struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool CloseHandle(IntPtr handle);

    [LibraryImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    internal static partial IntPtr CreateJobObject(IntPtr securityAttributes, string? name);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetInformationJobObject(SafeJobObjectHandle job, int infoClass, IntPtr info, uint length);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsProcessInJob(
        SafeProcessObjectHandle process,
        SafeJobObjectHandle job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [LibraryImport("kernel32.dll")]
    internal static partial void DeleteProcThreadAttributeList(IntPtr attributeList);

    [LibraryImport("kernel32.dll", EntryPoint = "CreateProcessW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool CreateProcess(
        string? applicationName,
        IntPtr commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool TerminateProcess(SafeProcessObjectHandle process, uint exitCode);
}
