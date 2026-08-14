using Avalonia;
using Avalonia.Controls;
using Avalonia.Fonts.Inter;
using GptAccountKeeper.Desktop.Application;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using Velopack;

namespace GptAccountKeeper.Desktop;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        // Update hooks must run before Avalonia starts. Automatic apply is disabled:
        // every installation is first drained through Keeper.Agent.
        VelopackApp.Build()
            .SetAutoApplyOnStartup(false)
            .Run();

        // 单实例按数据目录划分：开发模式与安装模式用不同目录，可以同时运行。
        // 同一目录下的第二个实例只把已有窗口带到前台，然后退出。
        var paths = AppPaths.Create();
        if (!SingleInstanceGuard.TryAcquire(paths.DataDirectory))
        {
            SingleInstanceGuard.TrySignalExistingWindow(paths.DataDirectory);
            return;
        }

        try
        {
            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args, ShutdownMode.OnExplicitShutdown);
        }
        finally
        {
            SingleInstanceGuard.Release();
        }
    }

    public static AppBuilder BuildAvaloniaApp()
    {
        return AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
    }
}
