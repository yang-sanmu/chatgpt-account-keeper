using GptAccountKeeper.Desktop.Infrastructure.Agent;
using GptAccountKeeper.Desktop.Infrastructure.Ipc;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Infrastructure.Updates;
using GptAccountKeeper.Desktop.Presentation;

namespace GptAccountKeeper.Desktop.Application;

internal sealed class AppBootstrapper : IAsyncDisposable
{
    private readonly AgentConnectionService _connection;
    private readonly UpdateService _updates;

    private AppBootstrapper(
        AgentConnectionService connection,
        UpdateService updates,
        ShellViewModel shell)
    {
        _connection = connection;
        _updates = updates;
        Shell = shell;
    }

    public ShellViewModel Shell { get; }

    public static AppBootstrapper Create()
    {
        // Deliberately explicit composition root: no reflection-based DI container.
        var paths = AppPaths.Create();
        var settings = new DesktopSettingsStore(paths);
        var dataLocation = new DataLocationService(paths);
        var startupRegistration = new StartupRegistrationService();
        var updates = new UpdateService();
        // 默认数据目录沿用 v1 端点，保证升级后可接回仍在后台运行的旧 Agent；
        // 用户选择的其它数据目录继续使用目录哈希隔离。
        var endpoint = AgentEndpointResolver.Resolve(
            paths.DataDirectory,
            paths.UsesDefaultDataDirectory);
        var ipcCredential = new IpcCredentialStore().LoadOrCreate(paths.IpcKeyFile);
        var launcher = new AgentProcessLauncher(paths, ipcCredential);
        var connection = new AgentConnectionService(endpoint, launcher, ipcCredential, paths.DataDirectory);
        var shell = new ShellViewModel(
            connection,
            settings,
            dataLocation,
            startupRegistration,
            updates,
            paths);
        return new AppBootstrapper(connection, updates, shell);
    }

    public async ValueTask DisposeAsync()
    {
        Shell.Stop();
        _updates.Dispose();
        await _connection.DisposeAsync();
    }
}
