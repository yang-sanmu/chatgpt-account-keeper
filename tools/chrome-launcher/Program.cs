using System.Text.Json;

namespace GptAccountKeeper.ChromeLauncher;

/// <summary>
/// Agent-level Chrome launcher broker.
///
/// One broker per Agent, not one per BrowserRun: it is the sole holder of every
/// per-run Job handle, which is what makes KILL_ON_JOB_CLOSE the reliable backstop.
/// A per-run helper would leak one process per run and, once crashed, leave the job
/// unqueryable.
///
/// stdout carries protocol frames only; diagnostics go to stderr.
/// </summary>
internal static class Program
{
    public const int ProtocolVersion = 1;

    private static readonly BrokerRegistry Registry = new();
    private static readonly string GenerationId = Guid.NewGuid().ToString("N");
    private static TextWriter _out = Console.Out;

    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("chrome-launcher broker is Windows-only; POSIX uses process groups.");
            return 2;
        }

        if (args.Length > 0 && args[0] == "--print-generation")
        {
            Console.Out.WriteLine(GenerationId);
            return 0;
        }

        // Both directions must be pinned to UTF-8 without BOM. Console.In/Out default to
        // the OS code page, which corrupts non-ASCII payloads (profile paths) and made
        // the very first ready handshake fail with a bogus JSON parse error.
        var stdout = Console.OpenStandardOutput();
        _out = new StreamWriter(stdout, new System.Text.UTF8Encoding(false)) { AutoFlush = true };
        var stdin = Console.OpenStandardInput();
        var reader = new StreamReader(stdin, new System.Text.UTF8Encoding(false));

        // Announce generation before any request so the Agent can bind to it.
        Write(new BrokerResponse
        {
            Command = "hello",
            Ok = true,
            BrokerGenerationId = GenerationId,
            ProtocolVersion = ProtocolVersion,
            Rid = Rid(),
            Pid = Environment.ProcessId,
        });

        try
        {
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (line.Length == 0) continue;
                HandleLine(line);
            }
        }
        catch (IOException error)
        {
            Console.Error.WriteLine($"broker stdin failure: {error.Message}");
        }

        // stdin EOF means the Agent is gone (normal shutdown closes the pipe after its
        // own shutdown command, an killed Agent closes it abruptly). Either way, drop
        // every job handle so KILL_ON_JOB_CLOSE reclaims all remaining Chrome trees.
        // Nothing is waited on here: there is no Agent left to ack.
        Registry.DisposeAllHandles();
        return 0;
    }

    private static string Rid() => Environment.Is64BitProcess ? "win-x64" : "win-x86";

    private static void Write(BrokerResponse response)
    {
        _out.WriteLine(response.ToLine());
    }

    private static void HandleLine(string line)
    {
        BrokerRequest? request;
        try
        {
            request = JsonSerializer.Deserialize(line, BrokerJson.Default.BrokerRequest);
        }
        catch (JsonException error)
        {
            Write(new BrokerResponse { Ok = false, Code = BrokerCodes.InvalidRequest, Message = error.Message });
            return;
        }
        if (request?.Command is null || request.RequestId is null)
        {
            Write(new BrokerResponse { Ok = false, Code = BrokerCodes.InvalidRequest, Message = "requestId and command are required" });
            return;
        }

        var response = new BrokerResponse
        {
            RequestId = request.RequestId,
            Command = request.Command,
            BrokerGenerationId = GenerationId,
            RunToken = request.RunToken,
        };

        // Every command except ready/hello must match this broker generation, so a stale
        // Agent-side retry can never touch a newer broker's state.
        if (request.Command != "ready"
            && request.BrokerGenerationId is not null
            && !string.Equals(request.BrokerGenerationId, GenerationId, StringComparison.Ordinal))
        {
            response.Ok = false;
            response.Code = BrokerCodes.GenerationMismatch;
            response.Message = "brokerGenerationId does not match this broker";
            Write(response);
            return;
        }

        try
        {
            switch (request.Command)
            {
                case "ready": Ready(request, response); break;
                case "launch": Launch(request, response); break;
                case "enumerate": Enumerate(request, response); break;
                case "terminate": Terminate(request, response); break;
                case "inspect": Inspect(request, response); break;
                case "dispose": Dispose(request, response); break;
                case "forget": Forget(request, response); break;
                case "shutdown": Shutdown(response); break;
                default:
                    response.Ok = false;
                    response.Code = BrokerCodes.UnknownCommand;
                    response.Message = $"unknown command: {request.Command}";
                    break;
            }
        }
        catch (Exception error)
        {
            response.Ok = false;
            response.Code = BrokerCodes.Internal;
            response.Message = error.Message;
            Console.Error.WriteLine($"broker {request.Command} failed: {error}");
        }
        Write(response);
    }

    private static void Ready(BrokerRequest request, BrokerResponse response)
    {
        if (request.ProtocolVersion is int requested && requested != ProtocolVersion)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = $"protocol mismatch: agent {requested}, broker {ProtocolVersion}";
            return;
        }
        if (request.Rid is { Length: > 0 } rid && !string.Equals(rid, Rid(), StringComparison.OrdinalIgnoreCase))
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = $"rid mismatch: agent {rid}, broker {Rid()}";
            return;
        }
        response.Ok = true;
        response.ProtocolVersion = ProtocolVersion;
        response.Rid = Rid();
        response.Capabilities = ["per-run-job", "creation-time-containment", "tombstone-idempotent-dispose"];
        response.Pid = Environment.ProcessId;
        // Reported so a standalone Agent (no Desktop) can log that it lacks the
        // outer-job backstop. Not a failure: CLI/dev runs are still allowed.
        response.ParentInJob = ParentHasJob();
        response.ActiveCount = Registry.ActiveCount;
        response.TombstoneCount = Registry.TombstoneCount;
    }

    private static bool ParentHasJob()
    {
        try
        {
            using var self = new SafeProcessHandle(Win32.GetCurrentProcess());
            // Passing a null job asks "is this process in ANY job".
            using var none = new SafeJobHandle(IntPtr.Zero);
            return Win32.IsProcessInJob(self, none, out var inJob) && inJob;
        }
        catch
        {
            return false;
        }
        finally
        {
            GC.KeepAlive(Registry);
        }
    }

    private static void Launch(BrokerRequest request, BrokerResponse response)
    {
        if (request.RunToken is not { Length: > 0 } token || request.Executable is not { Length: > 0 } executable)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = "runToken and executable are required";
            return;
        }
        // A token is single-use for launch even after dispose: reuse would make the
        // tombstone ambiguous between "old run reclaimed" and "new run running".
        if (Registry.TryGetActive(token, out _))
        {
            response.Ok = false;
            response.Code = BrokerCodes.TokenInUse;
            response.Message = "runToken is already active";
            return;
        }
        if (Registry.IsTombstoned(token))
        {
            response.Ok = false;
            response.Code = BrokerCodes.TokenRetired;
            response.Message = "runToken has already been disposed and cannot be reused";
            return;
        }
        if (!Registry.TombstoneCapacityAvailable)
        {
            response.Ok = false;
            response.Code = BrokerCodes.CapacityExhausted;
            response.Message = "tombstone capacity exhausted; refusing new launch";
            return;
        }

        var job = Win32.CreateKillOnCloseJob();
        try
        {
            var (pid, startTime, process) = ChromeStarter.Launch(
                job,
                executable,
                request.Args ?? [],
                request.WorkingDirectory);
            Registry.AddActive(new RunEntry
            {
                RunToken = token,
                Job = job,
                RootProcess = process,
                RootPid = pid,
                RootStartTime = startTime,
            });
            response.Ok = true;
            response.RootPid = pid;
            response.RootStartTime = startTime;
        }
        catch (Exception error)
        {
            // Closing the job here also terminates anything that already joined it.
            job.Dispose();
            response.Ok = false;
            response.Code = BrokerCodes.LaunchFailed;
            response.Message = error.Message;
        }
    }

    private static void Enumerate(BrokerRequest request, BrokerResponse response)
    {
        if (request.RunToken is not { Length: > 0 } token)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = "runToken is required";
            return;
        }
        if (Registry.TryGetActive(token, out var entry))
        {
            var pids = Win32.QueryJobProcessIds(entry.Job);
            response.Ok = true;
            response.Count = pids.Length;
            response.Pids = pids;
            response.Disposed = false;
            response.RootAlive = pids.Contains(entry.RootPid);
            return;
        }
        if (Registry.IsTombstoned(token))
        {
            // Idempotent proof for the lost-ack case: the job was already emptied and
            // disposed, so report the terminal state instead of UNKNOWN_TOKEN.
            response.Ok = true;
            response.Count = 0;
            response.Pids = [];
            response.Disposed = true;
            response.RootAlive = false;
            return;
        }
        response.Ok = false;
        response.Code = BrokerCodes.UnknownToken;
        response.Message = "unknown runToken";
    }

    /// <summary>
    /// Per-pid membership check via IsProcessInJob. Comparing an OS process walk against
    /// a job pid list is NOT a valid criterion: the two snapshots are taken at different
    /// instants, so a short-lived utility process that exits in between shows up as a
    /// phantom "escape". IsProcessInJob answers the question directly for a given pid.
    /// </summary>
    private static void Inspect(BrokerRequest request, BrokerResponse response)
    {
        if (request.RunToken is not { Length: > 0 } token)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = "runToken is required";
            return;
        }
        var candidates = request.Args ?? [];
        if (!Registry.TryGetActive(token, out var entry))
        {
            if (Registry.IsTombstoned(token))
            {
                response.Ok = true;
                response.Count = 0;
                response.Pids = [];
                response.Disposed = true;
                return;
            }
            response.Ok = false;
            response.Code = BrokerCodes.UnknownToken;
            response.Message = "unknown runToken";
            return;
        }

        var outside = new List<int>();
        foreach (var raw in candidates)
        {
            if (!int.TryParse(raw, out var pid)) continue;
            var handle = OpenProcessForQuery(pid);
            if (handle is null) continue; // already exited: not an escape
            using (handle)
            {
                if (!Win32.IsProcessInJob(handle, entry.Job, out var inJob) || !inJob)
                {
                    outside.Add(pid);
                }
            }
        }
        response.Ok = true;
        response.Pids = outside.ToArray();
        response.Count = outside.Count;
        response.Disposed = false;
    }

    private const int ProcessQueryLimitedInformation = 0x1000;

    private static SafeProcessHandle? OpenProcessForQuery(int pid)
    {
        var raw = Win32.OpenProcess(ProcessQueryLimitedInformation, false, pid);
        return raw == IntPtr.Zero ? null : new SafeProcessHandle(raw);
    }

    private static void Terminate(BrokerRequest request, BrokerResponse response)
    {
        if (request.RunToken is not { Length: > 0 } token)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = "runToken is required";
            return;
        }
        if (Registry.TryGetActive(token, out var entry))
        {
            // Single atomic call: no half-killed intermediate state, and unlike
            // taskkill /T it does not depend on the parent/child graph still existing.
            if (!Win32.TerminateJobObject(entry.Job, 1))
            {
                var error = new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
                response.Ok = false;
                response.Code = BrokerCodes.Internal;
                response.Message = $"TerminateJobObject failed: {error.Message}";
                return;
            }
            var pids = Win32.QueryJobProcessIds(entry.Job);
            response.Ok = true;
            response.Count = pids.Length;
            response.Pids = pids;
            response.Disposed = false;
            return;
        }
        if (Registry.IsTombstoned(token))
        {
            response.Ok = true;
            response.Count = 0;
            response.Pids = [];
            response.Disposed = true;
            return;
        }
        response.Ok = false;
        response.Code = BrokerCodes.UnknownToken;
        response.Message = "unknown runToken";
    }

    private static void Dispose(BrokerRequest request, BrokerResponse response)
    {
        if (request.RunToken is not { Length: > 0 } token)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = "runToken is required";
            return;
        }
        if (Registry.TryGetActive(token, out var entry))
        {
            var pids = Win32.QueryJobProcessIds(entry.Job);
            if (pids.Length != 0)
            {
                // Never release ownership while members remain: that is exactly the
                // "released the slot while renderers were alive" failure being fixed.
                response.Ok = false;
                response.Code = BrokerCodes.JobNotEmpty;
                response.Count = pids.Length;
                response.Pids = pids;
                response.Message = "job still has members; dispose refused";
                return;
            }
            Registry.Dispose(token);
            response.Ok = true;
            response.Count = 0;
            response.Disposed = true;
            return;
        }
        if (Registry.IsTombstoned(token))
        {
            response.Ok = true;
            response.Count = 0;
            response.Disposed = true;
            return;
        }
        response.Ok = false;
        response.Code = BrokerCodes.UnknownToken;
        response.Message = "unknown runToken";
    }

    private static void Forget(BrokerRequest request, BrokerResponse response)
    {
        if (request.RunToken is not { Length: > 0 } token)
        {
            response.Ok = false;
            response.Code = BrokerCodes.InvalidRequest;
            response.Message = "runToken is required";
            return;
        }
        // Idempotent for tombstoned and unknown alike, so a lost forget response
        // simply retries without ever turning into an error the Agent must handle.
        Registry.Forget(token);
        response.Ok = true;
        response.Disposed = true;
        response.TombstoneCount = Registry.TombstoneCount;
    }

    private static void Shutdown(BrokerResponse response)
    {
        var active = Registry.ActiveCount;
        if (active != 0)
        {
            // Refuse: exiting would reclaim Chrome via KILL_ON_JOB_CLOSE and could be
            // mistaken for a clean per-run close. The Agent must treat this as fatal.
            response.Ok = false;
            response.Code = BrokerCodes.ActiveRunsRemain;
            response.ActiveCount = active;
            response.Message = "active runs remain; refusing shutdown";
            return;
        }
        // Tombstones hold no OS resources, so clearing them on shutdown is safe.
        Registry.ForgetAllTombstones();
        response.Ok = true;
        response.ActiveCount = 0;
        response.TombstoneCount = 0;
        Write(response);
        _out.Flush();
        Environment.Exit(0);
    }
}
