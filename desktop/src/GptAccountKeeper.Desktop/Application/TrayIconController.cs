using System.ComponentModel;
using Avalonia.Controls;
using GptAccountKeeper.Desktop.Presentation;

namespace GptAccountKeeper.Desktop.Application;

internal sealed class TrayIconController : IDisposable
{
    private readonly TrayIcon _trayIcon;
    private readonly ShellViewModel _shell;
    private readonly NativeMenuItem _startScheduler;
    private readonly NativeMenuItem _stopScheduler;

    public TrayIconController(
        Avalonia.Application application,
        MainWindow window,
        ShellViewModel shell)
    {
        _shell = shell;
        var showItem = new NativeMenuItem("打开管理界面");
        showItem.Click += (_, _) => window.ShowAndActivate();
        _startScheduler = new NativeMenuItem("启动调度");
        _startScheduler.Click += (_, _) => shell.Overview.StartSchedulerCommand.Execute(null);
        _stopScheduler = new NativeMenuItem("停止调度");
        _stopScheduler.Click += (_, _) => shell.Overview.StopSchedulerCommand.Execute(null);
        var checkUpdate = new NativeMenuItem("检查更新");
        checkUpdate.Click += (_, _) => shell.Behavior.CheckUpdateCommand.Execute(null);
        var exitItem = new NativeMenuItem("退出全部");
        exitItem.Click += (_, _) => _ = window.RequestExitAllAsync();

        var menu = new NativeMenu();
        menu.Items.Add(showItem);
        menu.Items.Add(new NativeMenuItemSeparator());
        menu.Items.Add(_startScheduler);
        menu.Items.Add(_stopScheduler);
        menu.Items.Add(new NativeMenuItemSeparator());
        menu.Items.Add(checkUpdate);
        menu.Items.Add(new NativeMenuItemSeparator());
        menu.Items.Add(exitItem);

        _trayIcon = new TrayIcon
        {
            Icon = AppIcon.CreateTrayIcon(),
            ToolTipText = "ChatGPT Account Keeper",
            Menu = menu,
            IsVisible = true,
        };
        _trayIcon.Clicked += (_, _) => window.ShowAndActivate();
        TrayIcon.SetIcons(application, new TrayIcons { _trayIcon });

        // 托盘菜单和总览页共用同一份调度状态：菜单项跟着实际状态启停，
        // 不会出现调度已在运行还提示"启动调度"可点的情况。
        _shell.Overview.PropertyChanged += OnOverviewPropertyChanged;
        ApplySchedulerState();
    }

    public void Dispose()
    {
        _shell.Overview.PropertyChanged -= OnOverviewPropertyChanged;
        _trayIcon.IsVisible = false;
        _trayIcon.Dispose();
    }

    private void OnOverviewPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(_shell.Overview.SchedulerRunning) or null)
        {
            ApplySchedulerState();
        }
    }

    private void ApplySchedulerState()
    {
        var running = _shell.Overview.SchedulerRunning;
        _startScheduler.IsEnabled = !running;
        _stopScheduler.IsEnabled = running;
        _trayIcon.ToolTipText = running
            ? "ChatGPT Account Keeper · 调度运行中"
            : "ChatGPT Account Keeper · 调度已停止";
    }
}
