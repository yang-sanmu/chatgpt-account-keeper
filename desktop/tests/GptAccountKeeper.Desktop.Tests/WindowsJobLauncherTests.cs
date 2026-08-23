using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using GptAccountKeeper.Desktop.Infrastructure.Agent;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

// Fixture trap when doing the plan's mandatory red-before-green on this file:
// restoring the source with `Copy-Item` preserves the ORIGINAL timestamp, so MSBuild's
// incremental build considers the assembly up to date and `dotnet test` silently reruns
// the still-broken DLL. The "restore" then looks like it failed when the source is
// actually correct. Always follow a Copy-Item restore with
//   dotnet build --no-restore --no-incremental
// (or touch the file) before re-running, and confirm the source text separately.

public sealed class WindowsJobLauncherTests
{
    [Fact]
    public void BuildCommandLine_QuotesPathsWithSpaces()
    {
        var startInfo = new ProcessStartInfo { FileName = @"C:\Program Files\node\node.exe" };
        startInfo.ArgumentList.Add(@"C:\Users\A B\agent\launcher.js");
        startInfo.ArgumentList.Add("--data-root");
        startInfo.ArgumentList.Add(@"C:\Users\A B\data");

        var commandLine = WindowsJobLauncher.BuildCommandLine(startInfo);

        // Naive joining would split "A B" into two arguments and the Agent would start
        // against the wrong data root.
        Assert.Equal(
            @"""C:\Program Files\node\node.exe"" ""C:\Users\A B\agent\launcher.js"" --data-root ""C:\Users\A B\data""",
            commandLine);
    }

    [Fact]
    public void AppendArgument_DoublesTrailingBackslashesBeforeClosingQuote()
    {
        var builder = new StringBuilder();
        WindowsJobLauncher.AppendArgument(builder, @"C:\path with space\");

        // A single trailing backslash would escape the closing quote and corrupt the
        // whole remainder of the command line.
        Assert.Equal(@"""C:\path with space\\""", builder.ToString());
    }

    [Fact]
    public void AppendArgument_EscapesEmbeddedQuotes()
    {
        var builder = new StringBuilder();
        WindowsJobLauncher.AppendArgument(builder, "--flag=\"value\"");
        Assert.Equal("\"--flag=\\\"value\\\"\"", builder.ToString());
    }

    [Fact]
    public void BuildEnvironmentBlock_PreservesExplicitOverrides()
    {
        var startInfo = new ProcessStartInfo();
        startInfo.Environment["GPT_TEST_MARKER"] = "marker-value";
        var block = WindowsJobLauncher.BuildEnvironmentBlock(startInfo);
        try
        {
            var decoded = ReadEnvironmentBlock(block);
            Assert.Contains("GPT_TEST_MARKER=marker-value", decoded);
        }
        finally
        {
            Marshal.FreeHGlobal(block);
        }
    }

    private static List<string> ReadEnvironmentBlock(IntPtr block)
    {
        var entries = new List<string>();
        var offset = 0;
        while (true)
        {
            var current = new StringBuilder();
            char ch;
            while ((ch = (char)Marshal.ReadInt16(block, offset)) != '\0')
            {
                current.Append(ch);
                offset += 2;
            }
            offset += 2;
            if (current.Length == 0) break;
            entries.Add(current.ToString());
        }
        return entries;
    }

    /// <summary>
    /// Positive case: a stub whose FIRST action is to spawn a grandchild. Both must be in
    /// the job before any further user code runs, which is what creation-time containment
    /// guarantees and post-start assign does not.
    /// </summary>
    [Fact]
    public void Launch_ContainsAgentAndItsImmediatelySpawnedChild()
    {
        // Containment is a Windows guarantee; on other platforms there is nothing to assert.
        if (!OperatingSystem.IsWindows()) return;

        var startInfo = BuildStubStartInfo();
        AgentJobLaunch? launch = null;
        try
        {
            launch = WindowsJobLauncher.Launch(startInfo);
            Assert.True(IsInJob(launch.Process.Id, launch.Job), "Agent 必须在创建时刻就在 Job 内");

            var grandchild = WaitForChild(launch.Process.Id, TimeSpan.FromSeconds(25));
            Assert.True(grandchild > 0, "stub 应在首条指令 spawn 出子进程");
            Assert.True(
                IsInJob(grandchild, launch.Job),
                "首条指令 spawn 出的后代必须继承 Job；否则 Desktop 崩溃时兜底失效");
        }
        finally
        {
            if (launch is not null)
            {
                // Closing the job is the reclaim path; it must take the whole tree.
                launch.Job.Dispose();
                try { launch.Process.Dispose(); } catch { /* ignore */ }
            }
        }
    }

    /// <summary>
    /// Counter-example: the OLD approach. Kept permanently so nobody reintroduces
    /// post-start assign. Measured behaviour is agentInJob=true, brokerInJob=false, and
    /// the escaped grandchild even survives TerminateJobObject on the outer job.
    ///
    /// The assign MUST happen only after the grandchild is confirmed to exist. Using a
    /// fixed delay systematically hides the window and produces a false pass.
    /// </summary>
    [Fact]
    public void PostStartAssign_LeaksTheImmediatelySpawnedChild()
    {
        if (!OperatingSystem.IsWindows()) return;

        var job = CreateKillOnCloseJob();
        Process? agent = null;
        var grandchild = 0;
        try
        {
            agent = Process.Start(BuildStubStartInfo())!;
            grandchild = WaitForChild(agent.Id, TimeSpan.FromSeconds(25));
            Assert.True(grandchild > 0, "stub 应先 spawn 出子进程，否则无法暴露窗口");

            var handle = NativeMethods.OpenProcess(0x1F0FFF, false, agent.Id);
            Assert.True(NativeMethods.AssignProcessToJobObject(job, handle));
            NativeMethods.CloseHandle(handle);

            Assert.True(IsInJobRaw(agent.Id, job), "父进程可以被事后 assign");
            Assert.False(
                IsInJobRaw(grandchild, job),
                "AssignProcessToJobObject 不追溯：已存在的后代不会被补进 Job。若此断言变绿，"
                    + "说明反例已失效，创建时纳管的论证必须重新验证");
        }
        finally
        {
            NativeMethods.TerminateJobObject(job, 1);
            NativeMethods.CloseHandle(job);
            if (grandchild > 0) TryKill(grandchild);
            if (agent is not null) { TryKill(agent.Id); agent.Dispose(); }
        }
    }

    private static ProcessStartInfo BuildStubStartInfo()
    {
        // First statement spawns a grandchild, then sleeps.
        const string inner =
            "Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 45' "
            + "-WindowStyle Hidden; Start-Sleep -Seconds 45";
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add(inner);
        return startInfo;
    }

    private static int WaitForChild(int parentId, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            foreach (var candidate in Process.GetProcessesByName("powershell"))
            {
                using (candidate)
                {
                    if (GetParentProcessId(candidate.Id) == parentId) return candidate.Id;
                }
            }
            Thread.Sleep(100);
        }
        return 0;
    }

    private static int GetParentProcessId(int processId)
    {
        var info = new NativeMethods.ProcessBasicInformation();
        var handle = NativeMethods.OpenProcess(0x1000 | 0x0010, false, processId);
        if (handle == IntPtr.Zero) return 0;
        try
        {
            var status = NativeMethods.NtQueryInformationProcess(
                handle, 0, ref info, Marshal.SizeOf(info), out _);
            return status == 0 ? info.InheritedFromUniqueProcessId.ToInt32() : 0;
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static bool IsInJob(int processId, SafeJobObjectHandle job)
    {
        var handle = NativeMethods.OpenProcess(0x1000, false, processId);
        if (handle == IntPtr.Zero) return false;
        try
        {
            return NativeMethods.IsProcessInJobRaw(handle, job.DangerousGetHandle(), out var inJob) && inJob;
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static bool IsInJobRaw(int processId, IntPtr job)
    {
        var handle = NativeMethods.OpenProcess(0x1000, false, processId);
        if (handle == IntPtr.Zero) return false;
        try
        {
            return NativeMethods.IsProcessInJobRaw(handle, job, out var inJob) && inJob;
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        var job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        var size = Marshal.SizeOf<WindowsJobNative.JobObjectExtendedLimitInformation>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            var info = new WindowsJobNative.JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new WindowsJobNative.JobObjectBasicLimitInformation
                {
                    LimitFlags = WindowsJobNative.JobObjectLimitKillOnJobClose,
                },
            };
            Marshal.StructureToPtr(info, buffer, false);
            NativeMethods.SetInformationJobObjectRaw(job, 9, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    private static void TryKill(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            process.Kill(entireProcessTree: true);
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Win32Exception)
        {
        }
    }

    private static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct ProcessBasicInformation
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(int access, bool inherit, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
        public static extern bool SetInformationJobObjectRaw(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", EntryPoint = "IsProcessInJob", SetLastError = true)]
        public static extern bool IsProcessInJobRaw(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("ntdll.dll")]
        public static extern int NtQueryInformationProcess(
            IntPtr process,
            int infoClass,
            ref ProcessBasicInformation info,
            int infoLength,
            out int returnLength);
    }
}
