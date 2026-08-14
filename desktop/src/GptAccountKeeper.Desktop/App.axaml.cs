using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using GptAccountKeeper.Desktop.Application;
using GptAccountKeeper.Desktop.Presentation;
using System.Diagnostics;

namespace GptAccountKeeper.Desktop;

internal sealed partial class App : Avalonia.Application
{
    private AppBootstrapper? _bootstrapper;
    private TrayIconController? _trayIcon;
    private MainWindow? _mainWindow;
    private IClassicDesktopStyleApplicationLifetime? _desktopLifetime;
    private int _exitRequested;
    private bool _restartAfterExit;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            _desktopLifetime = desktop;
            desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            _bootstrapper = AppBootstrapper.Create();
            _bootstrapper.Shell.ApplicationExitRequested += (_, _) => RequestExit();
            _bootstrapper.Shell.DataDirectoryRestartRequested += (_, _) => RequestRestart();
            _mainWindow = new MainWindow(_bootstrapper.Shell, RequestExit);
            SingleInstanceGuard.RegisterActivationHandler(() =>
                Avalonia.Threading.Dispatcher.UIThread.Post(_mainWindow.ShowAndActivate));
            if (desktop.Args?.Contains("--hidden", StringComparer.OrdinalIgnoreCase) == true)
            {
                _mainWindow.Opened += (_, _) => _mainWindow.Hide();
            }
            desktop.MainWindow = _mainWindow;
            _trayIcon = new TrayIconController(this, _mainWindow, _bootstrapper.Shell);
            desktop.Exit += OnExit;
        }

        base.OnFrameworkInitializationCompleted();
    }

    private void RequestExit()
    {
        if (Interlocked.Exchange(ref _exitRequested, 1) != 0) return;
        _mainWindow?.PermitApplicationExit();
        _desktopLifetime?.Shutdown();
    }

    /// <summary>
    /// 换数据目录后重启。
    ///
    /// 之前是先 Process.Start 再 Shutdown：新旧两个实例有一段重叠期，都可能去启动
    /// Agent 并打开同一个数据目录。现在先退出、由 OnExit 在清理完成后再启动新实例。
    /// </summary>
    private void RequestRestart()
    {
        _restartAfterExit = true;
        RequestExit();
    }

    private void OnExit(object? sender, ControlledApplicationLifetimeExitEventArgs e)
    {
        _trayIcon?.Dispose();
        _trayIcon = null;
        if (_bootstrapper is not null)
        {
            _bootstrapper.DisposeAsync().AsTask().GetAwaiter().GetResult();
            _bootstrapper = null;
        }

        // 单实例互斥量已随本进程释放，新实例可以立刻取得。
        SingleInstanceGuard.Release();
        if (!_restartAfterExit) return;
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable)) return;
        Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            WorkingDirectory = AppContext.BaseDirectory,
        });
    }
}
