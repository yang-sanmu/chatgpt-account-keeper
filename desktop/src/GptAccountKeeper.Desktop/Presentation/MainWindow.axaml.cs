using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Platform.Storage;
using GptAccountKeeper.Desktop.Application;
using GptAccountKeeper.Desktop.Infrastructure.Updates;
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
        Icon = AppIcon.CreateWindowIcon();
        DataContext = viewModel;
        Opened += OnOpened;

        ViewModel.LegacyFolderRequested += OnLegacyFolderRequested;
        ViewModel.DataFolderRequested += OnDataFolderRequested;
        ViewModel.LegacyImportResumeRequested += OnLegacyImportResumeRequested;
        ViewModel.Behavior.UpdatePromptRequested = ShowUpdatePromptAsync;
        ViewModel.Behavior.UpdateProgressRequested = ShowUpdateProgressAsync;

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
            try
            {
                await ViewModel.ShutdownAgentAsync();
            }
            catch (Exception exception)
            {
                // 用户已经选择退出。Agent 停止失败需要记录，但不能再次把窗口锁住。
                Debug.WriteLine($"Agent 退出失败：{exception}");
            }
            try
            {
                await SaveWindowPlacementAsync();
            }
            catch (Exception exception)
            {
                // 窗口位置属于非关键偏好，写入失败不应阻止程序退出。
                Debug.WriteLine($"保存窗口位置失败：{exception}");
            }
            _requestApplicationExit();
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
            await RunLegacyImportAsync(folder.Path.LocalPath);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await new NoticeDialog("旧项目导入失败", exception.Message).ShowDialog(this);
        }
    }

    /// <summary>换数据目录重启后继续之前安排的导入，不再让用户重新选一次旧目录。</summary>
    private async void OnLegacyImportResumeRequested(object? sender, string legacyRoot)
    {
        try
        {
            // 导入要走确认对话框，而开机自启会带 --hidden 把窗口隐藏。
            // 隐藏窗口上开模态窗不可靠，先把主窗口显示出来。
            ShowAndActivate();
            await RunLegacyImportAsync(legacyRoot);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await new NoticeDialog("继续导入旧项目失败", exception.Message).ShowDialog(this);
        }
    }

    /// <summary>
    /// 预检旧项目并导入。
    ///
    /// 首次启动自动生成的空库允许就地导入；真正已有业务数据的库由迁移层拒绝，
    /// 用户仍可改选一个新的空数据目录，当前数据不会被覆盖。
    /// </summary>
    private async Task RunLegacyImportAsync(string selectedRoot)
    {
        var scan = await new MigrationScanDialog(
                selectedRoot,
                cancellationToken => ViewModel.InspectLegacyAsync(selectedRoot, cancellationToken))
            .ShowDialog<MigrationScanDialogResult?>(this);
        if (scan is null || scan.Cancelled) return;
        if (scan.Error is not null) throw scan.Error;

        var preview = scan.Preview
            ?? throw new InvalidOperationException("旧项目扫描没有返回结果");
        if (!preview.Ok)
        {
            await new NoticeDialog(
                "无法导入所选目录",
                $"[{preview.Error?.Code ?? "MIGRATION_PROBE_FAILED"}] {preview.Error?.Message ?? "迁移预检失败"}\n\n请选择包含 config、profiles 和 logs 的旧项目根目录。")
                .ShowDialog(this);
            return;
        }
        var confirmed = await new MigrationPreviewDialog(preview).ShowDialog<bool>(this);
        if (!confirmed) return;

        var databaseExisted = ViewModel.DataDirectoryInitialized;
        if (await ViewModel.ImportLegacyAsync(preview.SourceRoot) || !databaseExisted) return;

        var proceed = await new ConfirmationDialog(
            "需要一个新的数据目录",
            $"未能导入当前数据目录；如果其中已有业务数据，迁移不会覆盖它。\n\n是否改选一个空的新数据目录？确认后程序会重启并在那里完成导入，当前数据保持原样。\n\n旧项目：{preview.SourceRoot}")
            .ShowDialog<bool>(this);
        if (!proceed) return;

        var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "选择导入目标数据目录（必须是本地固定磁盘上尚未建库的目录）",
            AllowMultiple = false,
        });
        var target = folders.FirstOrDefault();
        if (target is null) return;
        await ViewModel.ScheduleLegacyImportAsync(preview.SourceRoot, target.Path.LocalPath);
    }

    private Task<UpdateChoice> ShowUpdatePromptAsync(UpdatePrompt prompt)
    {
        ShowAndActivate();
        return new UpdateAvailableDialog(
                prompt.Version,
                ViewModel.DesktopVersion,
                prompt.AlreadyDownloaded,
                prompt.Summary)
            .ShowDialog<UpdateChoice>(this);
    }

    private Task ShowUpdateProgressAsync(UpdateProgressRequest request)
    {
        ShowAndActivate();
        return new UpdateProgressDialog(request).ShowDialog(this);
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

}
