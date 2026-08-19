using System.Diagnostics;
using GptAccountKeeper.Desktop.Infrastructure.Ipc;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;
using System.Text.Json;

namespace GptAccountKeeper.Desktop.Infrastructure.Agent;

internal sealed record AgentLaunchResult(
    bool Started,
    string Message,
    int? ProcessId = null,
    string? LogFile = null,
    string? ProgressFile = null);

internal sealed class AgentProcessLauncher
{
    private const string ExecutableEnvironmentVariable = "GPTACCOUNTKEEPER_AGENT_EXECUTABLE";
    private const string NodeEnvironmentVariable = "GPTACCOUNTKEEPER_AGENT_NODE";
    private const string EntryEnvironmentVariable = "GPTACCOUNTKEEPER_AGENT_ENTRY";
    private readonly AppPaths _paths;
    private readonly string _ipcCredential;
    private readonly SemaphoreSlim _logGate = new(1, 1);

    public AgentProcessLauncher(AppPaths paths, string ipcCredential)
    {
        _paths = paths;
        _ipcCredential = ipcCredential;
    }

    public AgentLaunchResult TryStart(AgentEndpoint endpoint, string? legacyRoot = null)
    {
        var command = ResolveCommand();
        if (command is null)
        {
            return new AgentLaunchResult(
                false,
                "找不到随应用安装的 Agent 或私有 Node。开发覆盖必须显式配置 Agent/Node 路径。");
        }

        Directory.CreateDirectory(_paths.StateDirectory);
        if (!string.IsNullOrWhiteSpace(legacyRoot) && File.Exists(_paths.MigrationProgressFile))
        {
            File.Delete(_paths.MigrationProgressFile);
        }
        var startInfo = new ProcessStartInfo
        {
            FileName = command.FileName,
            WorkingDirectory = command.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        foreach (var argument in command.PrefixArguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        startInfo.ArgumentList.Add("--endpoint");
        startInfo.ArgumentList.Add(endpoint.Address);
        startInfo.ArgumentList.Add("--data-root");
        startInfo.ArgumentList.Add(_paths.DataDirectory);
        if (!string.IsNullOrWhiteSpace(legacyRoot))
        {
            startInfo.ArgumentList.Add("--legacy-root");
            startInfo.ArgumentList.Add(Path.GetFullPath(legacyRoot));
        }
        startInfo.Environment["GPTACCOUNTKEEPER_AGENT_ENDPOINT"] = endpoint.Address;
        startInfo.Environment["GPT_ACCOUNT_KEEPER_DATA_ROOT"] = _paths.DataDirectory;
        startInfo.Environment["GPT_ACCOUNT_KEEPER_CACHE_ROOT"] = _paths.CacheDirectory;
        startInfo.Environment["GPT_ACCOUNT_KEEPER_STATE_ROOT"] = _paths.StateDirectory;
        startInfo.Environment["GPT_ACCOUNT_KEEPER_RUNTIME_ROOT"] = Path.Combine(_paths.CacheDirectory, "run");
        startInfo.Environment["GPT_ACCOUNT_KEEPER_IPC_TOKEN"] = _ipcCredential;
        startInfo.Environment["GPT_ACCOUNT_KEEPER_MIGRATION_PROGRESS_FILE"] = _paths.MigrationProgressFile;
        startInfo.Environment["GPT_ACCOUNT_KEEPER_LOG_FILE"] = _paths.AgentLogFile;

        try
        {
            var process = Process.Start(startInfo);
            if (process is null)
            {
                return new AgentLaunchResult(false, "操作系统未能启动 Agent", LogFile: _paths.AgentLogFile);
            }
            var processId = process.Id;
            process.Dispose();
            _ = AppendLogAsync($"[{DateTimeOffset.Now:O}] Started Agent process {processId} ({(command.IsNode ? "Node sidecar" : "executable")}).");
            return new AgentLaunchResult(
                true,
                "Agent 已启动，正在等待 IPC…",
                processId,
                _paths.AgentLogFile,
                _paths.MigrationProgressFile);
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or System.ComponentModel.Win32Exception or IOException)
        {
            return new AgentLaunchResult(false, $"启动 Agent 失败：{exception.Message}", LogFile: _paths.AgentLogFile);
        }
    }

    public async Task<LegacyMigrationProbeResult> InspectLegacyAsync(
        string selectedRoot,
        CancellationToken cancellationToken = default)
    {
        var command = ResolveCommand();
        var probe = command is { IsNode: true } ? FindMigrationProbe(command) : null;
        if (command is null || probe is null)
        {
            return ProbeFailure(
                "MIGRATION_PROBE_UNAVAILABLE",
                "找不到随 Agent 安装的迁移检查程序；请确认开发依赖或重新安装应用");
        }

        Directory.CreateDirectory(_paths.StateDirectory);
        var startInfo = new ProcessStartInfo
        {
            FileName = command.FileName,
            WorkingDirectory = Path.GetDirectoryName(probe)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        startInfo.ArgumentList.Add(probe);
        startInfo.ArgumentList.Add("--legacy-root");
        startInfo.ArgumentList.Add(Path.GetFullPath(selectedRoot));
        startInfo.ArgumentList.Add("--data-root");
        startInfo.ArgumentList.Add(_paths.DataDirectory);

        try
        {
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return ProbeFailure("MIGRATION_PROBE_START_FAILED", "操作系统未能启动迁移检查程序");
            }
            using var cancellationRegistration = cancellationToken.Register(
                static state => TerminateProcessTree((Process)state!),
                process);
            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            var stdout = await stdoutTask.ConfigureAwait(false);
            var stderr = await stderrTask.ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(stderr))
            {
                await AppendLogAsync($"[migration-probe stderr]{Environment.NewLine}{stderr}").ConfigureAwait(false);
            }
            var json = stdout.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
                .LastOrDefault(line => line.TrimStart().StartsWith('{'));
            if (json is null)
            {
                return ProbeFailure(
                    "MIGRATION_PROBE_INVALID_OUTPUT",
                    $"迁移检查程序没有返回有效结果（退出码 {process.ExitCode}）");
            }
            return JsonSerializer.Deserialize(json, AppJsonContext.Default.LegacyMigrationProbeResult)
                ?? ProbeFailure("MIGRATION_PROBE_INVALID_OUTPUT", "迁移检查程序返回了空结果");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or System.ComponentModel.Win32Exception or JsonException)
        {
            return ProbeFailure("MIGRATION_PROBE_FAILED", exception.Message);
        }
    }

    private static void TerminateProcessTree(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (PlatformNotSupportedException)
        {
            try
            {
                process.Kill();
            }
            catch (Exception exception) when (
                exception is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // 进程可能刚好自行退出；取消流程仍可继续完成。
        }
    }

    private AgentCommand? ResolveCommand()
    {
        var executable = Environment.GetEnvironmentVariable(ExecutableEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(executable))
        {
            var fullExecutable = Path.GetFullPath(executable.Trim());
            return new AgentCommand(fullExecutable, Path.GetDirectoryName(fullExecutable)!, [], false);
        }

        var entry = Environment.GetEnvironmentVariable(EntryEnvironmentVariable);
        var agentEntry = !string.IsNullOrWhiteSpace(entry)
            ? Path.GetFullPath(entry.Trim())
            : FindAgentEntry(_paths.IsDevelopment);
        if (agentEntry is null || !File.Exists(agentEntry))
        {
            return null;
        }

        var node = Environment.GetEnvironmentVariable(NodeEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(node))
        {
            node = FindBundledNode();
            if (node is null && _paths.IsDevelopment)
            {
                node = "node";
            }
        }
        if (string.IsNullOrWhiteSpace(node)) return null;

        return new AgentCommand(node, Path.GetDirectoryName(agentEntry)!, [agentEntry], true);
    }

    private static string? FindBundledNode()
    {
        var executableName = OperatingSystem.IsWindows() ? "node.exe" : "node";
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "agent", "runtime", executableName),
            Path.Combine(AppContext.BaseDirectory, "runtime", executableName),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private static string? FindAgentEntry(bool allowDevelopmentSearch)
    {
        var directCandidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "agent", "src", "agent", "launcher.js"),
            Path.Combine(AppContext.BaseDirectory, "agent", "launcher.js"),
            Path.Combine(AppContext.BaseDirectory, "src", "agent", "launcher.js"),
        };
        var direct = directCandidates.FirstOrDefault(File.Exists);
        if (direct is not null)
        {
            return direct;
        }
        if (!allowDevelopmentSearch) return null;

        foreach (var start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var directory = new DirectoryInfo(start);
            for (var depth = 0; directory is not null && depth < 10; depth++, directory = directory.Parent)
            {
                var candidate = Path.Combine(directory.FullName, "src", "agent", "launcher.js");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    private static string? FindMigrationProbe(AgentCommand command)
    {
        var entry = command.PrefixArguments.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(entry)) return null;
        var candidate = Path.Combine(Path.GetDirectoryName(entry)!, "migrationProbe.js");
        return File.Exists(candidate) ? candidate : null;
    }

    private Task AppendLogAsync(string body)
    {
        return AppendLogCoreAsync(body);
    }

    private async Task AppendLogCoreAsync(string body)
    {
        await _logGate.WaitAsync().ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(_paths.StateDirectory);
            await File.AppendAllTextAsync(_paths.AgentLogFile, $"{body.TrimEnd()}{Environment.NewLine}").ConfigureAwait(false);
        }
        finally
        {
            _logGate.Release();
        }
    }

    private static LegacyMigrationProbeResult ProbeFailure(string code, string message) => new()
    {
        Ok = false,
        Error = new LegacyMigrationProbeError { Code = code, Message = message },
    };

    private sealed record AgentCommand(
        string FileName,
        string WorkingDirectory,
        IReadOnlyList<string> PrefixArguments,
        bool IsNode);
}
