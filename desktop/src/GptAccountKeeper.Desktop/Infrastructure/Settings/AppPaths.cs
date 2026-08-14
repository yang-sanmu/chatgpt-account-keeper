namespace GptAccountKeeper.Desktop.Infrastructure.Settings;

internal sealed record AppPaths(
    string ConfigurationDirectory,
    string SettingsFile,
    string BootstrapFile,
    string IpcKeyFile,
    string DataDirectory,
    string DatabaseFile,
    string CacheDirectory,
    string StateDirectory,
    string AgentLogFile,
    string MigrationProgressFile,
    bool IsDevelopment,
    string? BootstrapWarning)
{
    public bool UsesDefaultDataDirectory { get; init; }

    public static AppPaths Create()
    {
        var development = IsEnabled(Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_DEVELOPMENT"));
        var directoryName = development ? "GptAccountKeeper-dev" : "GptAccountKeeper";
        string configurationRoot;
        string dataRoot;
        string cacheRoot;
        string stateRoot;
        if (OperatingSystem.IsWindows())
        {
            configurationRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                directoryName);
            var localRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                directoryName);
            dataRoot = Path.Combine(localRoot, "data");
            cacheRoot = Path.Combine(localRoot, "cache");
            stateRoot = Path.Combine(localRoot, "state");
        }
        else if (OperatingSystem.IsMacOS())
        {
            var supportRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library",
                "Application Support",
                directoryName);
            configurationRoot = supportRoot;
            dataRoot = supportRoot;
            cacheRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library",
                "Caches",
                directoryName);
            stateRoot = Path.Combine(supportRoot, "state");
        }
        else
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var configured = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
            configurationRoot = string.IsNullOrWhiteSpace(configured)
                ? Path.Combine(
                    home,
                    ".config",
                    development ? "gpt-account-keeper-dev" : "gpt-account-keeper")
                : Path.Combine(configured, development ? "gpt-account-keeper-dev" : "gpt-account-keeper");
            var configuredData = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
            dataRoot = string.IsNullOrWhiteSpace(configuredData)
                ? Path.Combine(home, ".local", "share", development ? "gpt-account-keeper-dev" : "gpt-account-keeper")
                : Path.Combine(configuredData, development ? "gpt-account-keeper-dev" : "gpt-account-keeper");
            var configuredCache = Environment.GetEnvironmentVariable("XDG_CACHE_HOME");
            cacheRoot = string.IsNullOrWhiteSpace(configuredCache)
                ? Path.Combine(home, ".cache", development ? "gpt-account-keeper-dev" : "gpt-account-keeper")
                : Path.Combine(configuredCache, development ? "gpt-account-keeper-dev" : "gpt-account-keeper");
            var configuredState = Environment.GetEnvironmentVariable("XDG_STATE_HOME");
            stateRoot = string.IsNullOrWhiteSpace(configuredState)
                ? Path.Combine(home, ".local", "state", development ? "gpt-account-keeper-dev" : "gpt-account-keeper")
                : Path.Combine(configuredState, development ? "gpt-account-keeper-dev" : "gpt-account-keeper");
        }

        var defaultDataRoot = dataRoot;
        var bootstrapFile = Path.Combine(configurationRoot, "bootstrap.json");
        var bootstrapWarning = default(string);
        var explicitDataRoot = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_DESKTOP_DATA_ROOT");
        if (!string.IsNullOrWhiteSpace(explicitDataRoot))
        {
            dataRoot = ValidateDataRoot(explicitDataRoot);
        }
        else if (File.Exists(bootstrapFile))
        {
            try
            {
                using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(bootstrapFile));
                var root = document.RootElement;
                if (root.GetProperty("version").GetInt32() != 1 ||
                    !root.TryGetProperty("dataRoot", out var configuredRoot) ||
                    string.IsNullOrWhiteSpace(configuredRoot.GetString()))
                {
                    throw new InvalidDataException("bootstrap.json 缺少 version=1 或 dataRoot");
                }
                dataRoot = ValidateDataRoot(configuredRoot.GetString()!);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidDataException or ArgumentException)
            {
                bootstrapWarning = $"数据目录引导配置无效，已使用默认目录：{exception.Message}";
            }
        }

        return new AppPaths(
            configurationRoot,
            Path.Combine(configurationRoot, "desktop.json"),
            bootstrapFile,
            Path.Combine(configurationRoot, "ipc.key"),
            dataRoot,
            Path.Combine(dataRoot, "keeper.db"),
            cacheRoot,
            stateRoot,
            Path.Combine(stateRoot, "agent.log"),
            Path.Combine(stateRoot, "migration-progress.json"),
            development,
            bootstrapWarning)
        {
            UsesDefaultDataDirectory = PathsEqual(dataRoot, defaultDataRoot),
        };
    }

    private static bool IsEnabled(string? value) =>
        value is "1" or "true" or "TRUE" or "yes" or "YES";

    private static bool PathsEqual(string left, string right) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static string ValidateDataRoot(string value)
    {
        if (!Path.IsPathFullyQualified(value))
        {
            throw new ArgumentException("数据目录必须是绝对路径", nameof(value));
        }
        var full = Path.GetFullPath(value);
        if (Path.GetPathRoot(full)?.Equals(full, StringComparison.OrdinalIgnoreCase) == true)
        {
            throw new ArgumentException("数据目录不能是文件系统根目录", nameof(value));
        }
        if (OperatingSystem.IsWindows() && full.StartsWith(@"\\", StringComparison.Ordinal))
        {
            throw new ArgumentException("数据目录不能位于网络共享", nameof(value));
        }
        return full;
    }
}
