using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace GptAccountKeeper.ChromeLauncher;

/// <summary>
/// Job-object handle. Closing it is what triggers KILL_ON_JOB_CLOSE, so the broker
/// must be the only process holding one: a duplicate anywhere else means the handle
/// count never reaches zero and a broker crash would leave Chrome running.
/// </summary>
internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeJobHandle() : base(true) { }

    public SafeJobHandle(IntPtr handle) : base(true) => SetHandle(handle);

    protected override bool ReleaseHandle() => Win32.CloseHandle(handle);
}

internal sealed class SafeProcessHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeProcessHandle() : base(true) { }

    public SafeProcessHandle(IntPtr handle) : base(true) => SetHandle(handle);

    protected override bool ReleaseHandle() => Win32.CloseHandle(handle);
}

internal sealed class SafeThreadHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeThreadHandle() : base(true) { }

    public SafeThreadHandle(IntPtr handle) : base(true) => SetHandle(handle);

    protected override bool ReleaseHandle() => Win32.CloseHandle(handle);
}

/// <summary>
/// Attribute list backing store for PROC_THREAD_ATTRIBUTE_JOB_LIST. The job handle
/// it points at must stay alive and pinned until CreateProcessW returns.
/// </summary>
internal sealed class ProcThreadAttributeList : IDisposable
{
    private IntPtr _list;
    private IntPtr _jobHandleStorage;
    private bool _initialized;

    public IntPtr Handle => _list;

    public static ProcThreadAttributeList ForJob(SafeJobHandle job)
    {
        var list = new ProcThreadAttributeList();
        try
        {
            list.Initialize(job);
            return list;
        }
        catch
        {
            list.Dispose();
            throw;
        }
    }

    private void Initialize(SafeJobHandle job)
    {
        var size = IntPtr.Zero;
        // First call always fails with ERROR_INSUFFICIENT_BUFFER and reports the size.
        if (!Win32.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size)
            && Marshal.GetLastWin32Error() != Win32.ErrorInsufficientBuffer)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList sizing failed");
        }

        _list = Marshal.AllocHGlobal(size);
        if (!Win32.InitializeProcThreadAttributeList(_list, 1, 0, ref size))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
        }
        _initialized = true;

        // UpdateProcThreadAttribute stores a pointer to the value, not a copy, so the
        // storage has to outlive the call to CreateProcessW.
        _jobHandleStorage = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(_jobHandleStorage, job.DangerousGetHandle());

        if (!Win32.UpdateProcThreadAttribute(
                _list,
                0,
                Win32.ProcThreadAttributeJobList,
                _jobHandleStorage,
                (IntPtr)IntPtr.Size,
                IntPtr.Zero,
                IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute(JOB_LIST) failed");
        }
    }

    public void Dispose()
    {
        if (_initialized)
        {
            Win32.DeleteProcThreadAttributeList(_list);
            _initialized = false;
        }
        if (_list != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_list);
            _list = IntPtr.Zero;
        }
        if (_jobHandleStorage != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_jobHandleStorage);
            _jobHandleStorage = IntPtr.Zero;
        }
    }
}

internal static partial class Win32
{
    public const int ErrorInsufficientBuffer = 122;
    public const uint ExtendedStartupInfoPresent = 0x00080000;
    public const uint CreateNoWindow = 0x08000000;
    public const uint CreateUnicodeEnvironment = 0x00000400;
    public const uint CreateSuspended = 0x00000004;
    public const uint CreateBreakawayFromJob = 0x01000000;
    public static readonly IntPtr ProcThreadAttributeJobList = (IntPtr)0x0002000D;

    public const int JobObjectBasicProcessIdListClass = 3;
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
    internal static partial bool SetInformationJobObject(
        SafeJobHandle job,
        int infoClass,
        IntPtr info,
        uint infoLength);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool QueryInformationJobObject(
        SafeJobHandle job,
        int infoClass,
        IntPtr info,
        uint infoLength,
        IntPtr returnLength);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool TerminateJobObject(SafeJobHandle job, uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsProcessInJob(
        SafeProcessHandle process,
        SafeJobHandle job,
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

    // CreateProcessW may write into lpCommandLine, so it is passed as a mutable
    // native buffer rather than a marshalled string.
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
    internal static partial bool GetProcessTimes(
        SafeProcessHandle process,
        out long creation,
        out long exit,
        out long kernel,
        out long user);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetExitCodeProcess(SafeProcessHandle process, out uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    internal static partial uint ResumeThread(SafeThreadHandle thread);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    internal static partial IntPtr GetCurrentProcess();

    [LibraryImport("kernel32.dll", SetLastError = true)]
    internal static partial IntPtr OpenProcess(
        int desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    /// <summary>
    /// Creates a job whose KILL_ON_JOB_CLOSE limit is set BEFORE any process joins it.
    /// Reversing that order leaves a window where a member exists but the limit is not
    /// yet armed, so a crash in between would not reclaim the tree.
    /// </summary>
    public static SafeJobHandle CreateKillOnCloseJob()
    {
        var raw = CreateJobObject(IntPtr.Zero, null);
        if (raw == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }
        var job = new SafeJobHandle(raw);
        var info = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose,
            },
        };
        var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, buffer, (uint)size))
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
    /// The authoritative owned-set: every descendant inherits the job at creation time,
    /// so this enumeration has no sampling window. A parent/child process walk cannot
    /// give the same guarantee.
    /// </summary>
    public static int[] QueryJobProcessIds(SafeJobHandle job)
    {
        var capacity = 64;
        while (true)
        {
            // JOBOBJECT_BASIC_PROCESS_ID_LIST: 2 DWORDs then ULONG_PTR[].
            var size = (8 + (capacity * IntPtr.Size));
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                for (var i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
                if (!QueryInformationJobObject(job, JobObjectBasicProcessIdListClass, buffer, (uint)size, IntPtr.Zero))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error == ErrorInsufficientBuffer || error == 234 /* ERROR_MORE_DATA */)
                    {
                        capacity *= 4;
                        if (capacity > 65536) throw new Win32Exception(error, "job process list too large");
                        continue;
                    }
                    throw new Win32Exception(error, "QueryInformationJobObject(BasicProcessIdList) failed");
                }
                var assigned = Marshal.ReadInt32(buffer, 0);
                var returned = Marshal.ReadInt32(buffer, 4);
                if (assigned > returned)
                {
                    capacity = Math.Max(capacity * 4, assigned + 16);
                    if (capacity > 65536) throw new InvalidOperationException("job process list too large");
                    continue;
                }
                var ids = new int[returned];
                for (var i = 0; i < returned; i++)
                {
                    ids[i] = (int)Marshal.ReadIntPtr(buffer, 8 + (i * IntPtr.Size)).ToInt64();
                }
                return ids;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
