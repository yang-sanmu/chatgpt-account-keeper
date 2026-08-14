using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Platform.Storage;
using GptAccountKeeper.Desktop.Application;
using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

internal sealed partial class MainWindow : Window
{
    private readonly Action _requestApplicationExit;
    private bool _applicationExitRequested;
    private bool _closeFlowRunning;

    public MainWindow(ShellViewModel viewModel, Action requestApplicationExit)
    {
        ViewModel = viewModel;
        _requestApplicationExit = requestApplicationExit;
        InitializeComponent();
        Icon = AppIcon.Create();
        DataContext = viewModel;
        Opened += OnOpened;

        ViewModel.LegacyFolderRequested += OnLegacyFolderRequested;
        ViewModel.DataFolderRequested += OnDataFolderRequested;

        // 对话框、剪贴板和"打开文件夹"都由窗口提供，页面 ViewModel 不依赖顶层控件。
        ViewModel.Session.ConfirmAsync = (title, message, destructive) =>
            new ConfirmationDialog(title, message, destructive).ShowDialog<bool>(this);
        ViewModel.Accounts.AccountRemovalRequested = account =>
            new AccountRemovalDialog(account).ShowDialog<string?>(this);
        ViewModel.Accounts.LoginRequested = ShowLoginAsync;
        ViewModel.History.CopyRequested = CopyToClipboardAsync;
        ViewModel.Operations.CopyRequested = CopyToClipboardAsync;
        ViewModel.Settings.CopyRequested = CopyToClipboardAsync;
        ViewModel.Settings.RevealRequested = RevealAsync;
        ViewModel.Overview.RevealRequested = RevealAsync;
    }

    public ShellViewModel ViewModel { get; }

    public void ShowAndActivate()
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    public void PermitApplicationExit() => _applicationExitRequested = true;

    public async Task RequestExitAllAsync()
    {
        if (_closeFlowRunning || _applicationExitRequested) return;

        _closeFlowRunning = true;
        try
        {
            var activity = await ViewModel.GetActivityAsync();
            if (activity is not null && activity.Blockers.Length > 0)
            {
                var descriptions = activity.Blockers
                    .Select(blocker => $"• {BlockerName(blocker.Kind)}：{blocker.ResourceId ?? "未知资源"}");
                await new NoticeDialog(
                    "当前不能退出全部",
                    $"请先关闭真实 Chrome、登录窗口或等待关键任务结束：\n\n{string.Join("\n", descriptions)}")
                    .ShowDialog(this);
                return;
            }

            await ViewModel.ShutdownAgentAsync();
            await SaveWindowPlacementAsync();
            _requestApplicationExit();
        }
        catch (Exception exception)
        {
            await new NoticeDialog("退出失败", $"Agent 未能安全停止：{exception.Message}").ShowDialog(this);
        }
        finally
        {
            _closeFlowRunning = false;
        }
    }

    protected override async void OnClosing(WindowClosingEventArgs e)
    {
        if (!_applicationExitRequested)
        {
            e.Cancel = true;
            if (ViewModel.Behavior.CloseBehavior == CloseBehavior.MinimizeToTray)
            {
                await SaveWindowPlacementAsync();
                Hide();
            }
            else if (ViewModel.Behavior.CloseBehavior == CloseBehavior.ExitAll)
            {
                await RequestExitAllAsync();
            }
            else if (!_closeFlowRunning)
            {
                _closeFlowRunning = true;
                try
                {
                    var result = await new CloseChoiceDialog().ShowDialog<CloseChoiceResult?>(this);
                    if (result?.Remember == true)
                    {
                        await ViewModel.Behavior.RememberCloseChoiceAsync(result.Choice);
                    }
                    if (result?.Choice == CloseChoice.HideToTray)
                    {
                        await SaveWindowPlacementAsync();
                        Hide();
                    }
                    else if (result?.Choice == CloseChoice.ExitAll)
                    {
                        _closeFlowRunning = false;
                        await RequestExitAllAsync();
                    }
                }
                finally
                {
                    _closeFlowRunning = false;
                }
            }
        }

        base.OnClosing(e);
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        Opened -= OnOpened;
        await ViewModel.InitializeAsync();
        Width = ViewModel.Behavior.WindowWidth;
        Height = ViewModel.Behavior.WindowHeight;
        if (ViewModel.Behavior.WindowX is int x && ViewModel.Behavior.WindowY is int y)
        {
            var candidate = new PixelPoint(x, y);
            if (Screens.All.Any(screen => screen.WorkingArea.Contains(candidate)))
            {
                Position = candidate;
            }
        }
        if (ViewModel.Behavior.WindowMaximized) WindowState = WindowState.Maximized;
        ViewModel.StartSafeInstallMonitor();
    }

    private Task SaveWindowPlacementAsync()
    {
        var normal = WindowState == WindowState.Normal;
        return ViewModel.Behavior.SaveWindowPlacementAsync(
            normal ? Position.X : null,
            normal ? Position.Y : null,
            normal ? Bounds.Width : ViewModel.Behavior.WindowWidth,
            normal ? Bounds.Height : ViewModel.Behavior.WindowHeight,
            WindowState == WindowState.Maximized);
    }

    /// <summary>
    /// 登录进度窗。
    ///
    /// 登录需要用户在真实 Chrome 里操作，Agent 侧的 waiting_user 阶段是有上报的；
    /// 之前账号页只留下一句"登录已提交：queued · <guid>"，用户得自己切到任务页
    /// 才看得到"等待用户"。现在直接开一个模态窗跟随该任务。
    /// </summary>
    private async Task ShowLoginAsync(AccountDto account, bool force)
    {
        var dialog = new LoginProgressDialog(ViewModel.Session, account, force);
        await dialog.ShowDialog(this);
    }

    private async Task CopyToClipboardAsync(string text)
    {
        var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
        if (clipboard is null) return;
        await clipboard.SetTextAsync(text);
    }

    /// <summary>在系统文件管理器中定位数据目录或日志文件。</summary>
    private async Task RevealAsync(string path)
    {
        try
        {
            var target = File.Exists(path) ? Path.GetDirectoryName(path) ?? path : path;
            if (!Directory.Exists(target) && !File.Exists(target))
            {
                Directory.CreateDirectory(target);
            }
            var (fileName, argument) = OperatingSystem.IsWindows()
                ? ("explorer.exe", target)
                : OperatingSystem.IsMacOS()
                    ? ("open", target)
                    : ("xdg-open", target);
            Process.Start(new ProcessStartInfo(fileName, argument) { UseShellExecute = false });
        }
        catch (Exception exception)
        {
            await new NoticeDialog("无法打开该位置", $"{path}\n\n{exception.Message}").ShowDialog(this);
        }
    }

    private async void OnLegacyFolderRequested(object? sender, EventArgs e)
    {
        try
        {
            var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
            {
                Title = "选择旧版 GptAccount Keeper 项目根目录（也可选择 profiles，程序会识别父目录）",
                AllowMultiple = false,
            });
            var folder = folders.FirstOrDefault();
            if (folder is null) return;

            var preview = await ViewModel.InspectLegacyAsync(folder.Path.LocalPath);
            if (!preview.Ok)
            {
                await new NoticeDialog(
                    "无法导入所选目录",
                    $"[{preview.Error?.Code ?? "MIGRATION_PROBE_FAILED"}] {preview.Error?.Message ?? "迁移预检失败"}\n\n请选择包含 config、profiles 和 logs 的旧项目根目录。")
                    .ShowDialog(this);
                return;
            }
            var confirmed = await new MigrationPreviewDialog(preview).ShowDialog<bool>(this);
            if (confirmed) await ViewModel.ImportLegacyAsync(preview.SourceRoot);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await new NoticeDialog("旧项目导入失败", exception.Message).ShowDialog(this);
        }
    }

    private async void OnDataFolderRequested(object? sender, EventArgs e)
    {
        try
        {
            var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
            {
                Title = "选择 ChatGPT Account Keeper 数据目录（本地固定磁盘）",
                AllowMultiple = false,
            });
            var folder = folders.FirstOrDefault();
            if (folder is not null) await ViewModel.UseDataDirectoryAsync(folder.Path.LocalPath);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await new NoticeDialog("选择数据目录失败", exception.Message).ShowDialog(this);
        }
    }

    private static string BlockerName(string kind) => kind switch
    {
        "open-page" => "账号 Chrome 窗口",
        "operation" => "活动任务",
        "account-busy" => "账号浏览器任务",
        _ => kind,
    };
}
