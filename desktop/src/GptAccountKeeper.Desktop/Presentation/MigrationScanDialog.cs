using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

internal sealed record MigrationScanDialogResult(
    LegacyMigrationProbeResult? Preview,
    Exception? Error,
    bool Cancelled);

/// <summary>
/// 旧项目预检会遍历并哈希整个 Profile。大目录可能持续数分钟，因此必须在选择
/// 目录后立即给出可见反馈，并把取消操作传到真正执行扫描的子进程。
/// </summary>
internal sealed class MigrationScanDialog : Window
{
    private readonly Func<CancellationToken, Task<LegacyMigrationProbeResult>> _inspect;
    private readonly CancellationTokenSource _cancellation = new();
    private readonly TextBlock _stateText;
    private readonly TextBlock _messageText;
    private readonly Button _cancelButton;
    private bool _running = true;
    private bool _allowClose;

    public MigrationScanDialog(
        string selectedRoot,
        Func<CancellationToken, Task<LegacyMigrationProbeResult>> inspect)
    {
        _inspect = inspect;

        Title = "正在扫描旧项目";
        Width = 620;
        Height = 360;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        _stateText = new TextBlock
        {
            Text = "正在只读扫描旧项目…",
            FontSize = 18,
            FontWeight = FontWeight.Bold,
        };
        _messageText = new TextBlock
        {
            Text = "正在统计账号、历史记录并校验 Profile 内容。Profile 较大时可能需要几分钟，请耐心等待。",
            TextWrapping = TextWrapping.Wrap,
            Classes = { "muted" },
            FontSize = 12,
            LineHeight = 18,
        };
        _cancelButton = new Button
        {
            Content = "取消扫描",
            Padding = new Thickness(18, 8),
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        _cancelButton.Click += (_, _) => RequestCancellation();

        Content = new Border
        {
            Classes = { "card" },
            Margin = new Thickness(16),
            Padding = new Thickness(24),
            Child = new StackPanel
            {
                Spacing = 16,
                Children =
                {
                    _stateText,
                    new ProgressBar
                    {
                        IsIndeterminate = true,
                        Height = 6,
                        CornerRadius = new CornerRadius(3),
                    },
                    _messageText,
                    new Border
                    {
                        Padding = new Thickness(12, 8),
                        CornerRadius = new CornerRadius(6),
                        Classes = { "subtle-card" },
                        Child = new SelectableTextBlock
                        {
                            Text = selectedRoot,
                            TextWrapping = TextWrapping.Wrap,
                            Foreground = Palette.Info,
                            FontSize = 11,
                            FontFamily = FontFamily.Parse("Consolas, monospace"),
                        },
                    },
                    new Border
                    {
                        Padding = new Thickness(12, 8),
                        CornerRadius = new CornerRadius(6),
                        Classes = { "card" },
                        Child = new TextBlock
                        {
                            Text = "💡 扫描不会修改旧项目。导入完成前，请不要启动旧服务或使用相关 Chrome Profile。",
                            TextWrapping = TextWrapping.Wrap,
                            Classes = { "muted" },
                            FontSize = 11,
                            LineHeight = 16,
                        },
                    },
                    _cancelButton,
                },
            },
        };

        Opened += OnOpened;
        Closed += (_, _) => _cancellation.Dispose();
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        if (_running && !_allowClose)
        {
            e.Cancel = true;
            RequestCancellation();
        }

        base.OnClosing(e);
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        Opened -= OnOpened;
        try
        {
            var preview = await _inspect(_cancellation.Token);
            Complete(new MigrationScanDialogResult(preview, null, false));
        }
        catch (OperationCanceledException)
        {
            Complete(new MigrationScanDialogResult(null, null, true));
        }
        catch (Exception exception)
        {
            Complete(new MigrationScanDialogResult(null, exception, false));
        }
    }

    private void RequestCancellation()
    {
        if (!_running || _cancellation.IsCancellationRequested) return;

        _stateText.Text = "正在取消扫描…";
        _messageText.Text = "正在停止后台预检进程，请稍候。";
        _cancelButton.Content = "正在取消…";
        _cancelButton.IsEnabled = false;
        _cancellation.Cancel();
    }

    private void Complete(MigrationScanDialogResult result)
    {
        if (!_running) return;
        _running = false;
        _allowClose = true;
        Close(result);
    }
}
