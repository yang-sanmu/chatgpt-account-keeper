using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace GptAccountKeeper.Desktop.Presentation;

internal sealed record UpdateExecutionProgress(
    string Stage,
    string Message,
    int? Percent = null,
    bool CanCancel = true);

internal sealed record UpdateProgressRequest(
    string Version,
    bool AlreadyDownloaded,
    Func<IProgress<UpdateExecutionProgress>, CancellationToken, Task> Execute);

/// <summary>
/// “立即更新”的前端进度。下载和安全检查阶段允许取消；Agent 一旦进入事务式
/// 排空，就必须完成关闭和应用，避免取消把 Agent 留在拒绝写入的半停机状态。
/// </summary>
internal sealed class UpdateProgressDialog : Window
{
    private readonly UpdateProgressRequest _request;
    private readonly CancellationTokenSource _cancellation = new();
    private readonly TextBlock _stateText;
    private readonly TextBlock _messageText;
    private readonly ProgressBar _progressBar;
    private readonly Button _cancelButton;
    private bool _running = true;
    private bool _canCancel = true;
    private bool _allowClose;

    public UpdateProgressDialog(UpdateProgressRequest request)
    {
        _request = request;

        Title = $"正在更新到 {request.Version}";
        Width = 620;
        Height = 370;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Palette.BgDark;

        _stateText = new TextBlock
        {
            Text = request.AlreadyDownloaded ? "正在准备安装更新…" : "正在准备下载更新…",
            FontSize = 18,
            LineHeight = 26,
            FontWeight = FontWeight.Bold,
            Foreground = Palette.TextPrimary,
        };
        _messageText = new TextBlock
        {
            Text = request.AlreadyDownloaded
                ? "更新包已经下载完成，正在检查 Agent 是否处于安全安装点。"
                : "正在连接更新服务，下载过程中可以随时取消。",
            TextWrapping = TextWrapping.Wrap,
            Foreground = Palette.TextSecondary,
            FontSize = 12,
            LineHeight = 18,
        };
        _progressBar = new ProgressBar
        {
            Minimum = 0,
            Maximum = 100,
            IsIndeterminate = request.AlreadyDownloaded,
            Value = request.AlreadyDownloaded ? 100 : 0,
            Height = 6,
            CornerRadius = new CornerRadius(3),
        };
        _cancelButton = new Button
        {
            Content = "取消更新",
            Padding = new Thickness(20, 8),
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
                    new TextBlock
                    {
                        Text = $"目标版本 {request.Version}",
                        Foreground = Palette.Info,
                        FontSize = 12,
                        FontWeight = FontWeight.SemiBold,
                    },
                    _stateText,
                    _progressBar,
                    _messageText,
                    new Border
                    {
                        Padding = new Thickness(12, 8),
                        CornerRadius = new CornerRadius(6),
                        Background = Brush.Parse("#0F172A"),
                        BorderBrush = Brush.Parse("#1E2D4A"),
                        BorderThickness = new Thickness(1),
                        Child = new TextBlock
                        {
                            Text = "💡 下载与安全检查阶段可以随时取消；一旦开始排空 Agent 将自动完成安装并重启，避免损坏数据。",
                            TextWrapping = TextWrapping.Wrap,
                            Foreground = Palette.Muted,
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
        var progress = new DialogProgress(this);
        try
        {
            await _request.Execute(progress, _cancellation.Token);
            Finish(
                "更新准备完成",
                "应用即将重启；如果窗口没有自动关闭，可以手动关闭本提示。",
                failed: false);
        }
        catch (OperationCanceledException) when (_cancellation.IsCancellationRequested)
        {
            Finish("更新已取消", "更新包未安装，可以稍后重新检查更新。", failed: false);
        }
        catch (Exception exception)
        {
            Finish("更新失败", exception.Message, failed: true);
        }
    }

    private void ApplyProgress(UpdateExecutionProgress progress)
    {
        if (!_running) return;

        _stateText.Text = progress.Stage;
        _messageText.Text = progress.Message;
        _canCancel = progress.CanCancel;
        _cancelButton.IsEnabled = progress.CanCancel;
        _cancelButton.Content = progress.CanCancel ? "取消更新" : "正在安全安装…";
        _progressBar.IsIndeterminate = progress.Percent is null;
        if (progress.Percent is int percent)
        {
            _progressBar.Value = Math.Clamp(percent, 0, 100);
        }
    }

    private void RequestCancellation()
    {
        if (!_running)
        {
            _allowClose = true;
            Close();
            return;
        }
        if (!_canCancel || _cancellation.IsCancellationRequested) return;

        _stateText.Text = "正在取消更新…";
        _messageText.Text = "正在停止更新下载或安全检查，请稍候。";
        _cancelButton.Content = "正在取消…";
        _cancelButton.IsEnabled = false;
        _cancellation.Cancel();
    }

    private void Finish(string state, string message, bool failed)
    {
        _running = false;
        _canCancel = false;
        _stateText.Text = state;
        _stateText.Foreground = failed ? Palette.Danger : Palette.TextPrimary;
        _messageText.Text = message;
        _progressBar.IsIndeterminate = false;
        _progressBar.IsVisible = false;
        _cancelButton.Content = "关闭";
        _cancelButton.IsEnabled = true;
    }

    private sealed class DialogProgress(UpdateProgressDialog owner) : IProgress<UpdateExecutionProgress>
    {
        public void Report(UpdateExecutionProgress value)
        {
            if (Dispatcher.UIThread.CheckAccess())
            {
                owner.ApplyProgress(value);
            }
            else
            {
                Dispatcher.UIThread.Post(() => owner.ApplyProgress(value));
            }
        }
    }
}
