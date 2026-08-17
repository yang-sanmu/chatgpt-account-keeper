using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 登录进度窗 (Modern Slate Dark)。
///
/// 登录是唯一需要用户在真实 Chrome 里手动操作的流程，Agent 侧对它做了真实的多阶段
/// 上报（running / waiting_user / succeeded / failed / timed_out）。
/// </summary>
internal sealed class LoginProgressDialog : Window
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(400);
    private readonly AgentSession _session;
    private readonly AccountDto _account;
    private readonly bool _force;
    private readonly TextBlock _stateText;
    private readonly TextBlock _messageText;
    private readonly ProgressBar _spinner;
    private readonly Button _closeButton;
    private readonly CancellationTokenSource _cancellation = new();

    public LoginProgressDialog(AgentSession session, AccountDto account, bool force)
    {
        _session = session;
        _account = account;
        _force = force;

        Title = force ? "强制重新登录" : "账号登录";
        Width = 560;
        Height = 350;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Palette.BgDark;

        _stateText = new TextBlock
        {
            Text = "正在提交登录任务…",
            FontSize = 18,
            FontWeight = FontWeight.Bold,
            Foreground = Palette.TextPrimary,
        };
        _messageText = new TextBlock
        {
            Text = "Agent 会用该账号的 Profile 打开真实 Chrome。请在弹出的浏览器窗口里完成登录。",
            TextWrapping = TextWrapping.Wrap,
            Foreground = Palette.TextSecondary,
            FontSize = 12,
            LineHeight = 18,
        };
        _spinner = new ProgressBar { IsIndeterminate = true, Height = 5, CornerRadius = new CornerRadius(3) };
        _closeButton = new Button
        {
            Content = "在后台继续",
            Padding = new Thickness(18, 8),
            Classes = { "primary" },
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        _closeButton.Click += (_, _) => Close();

        var route = string.IsNullOrWhiteSpace(account.ProxyId)
            ? "出口：跟随系统网络"
            : account.ProxyMissing
                ? "出口：节点已失效，登录可能失败"
                : $"出口：{account.ProxyName ?? account.ProxyId}";

        Content = new Border
        {
            Classes = { "card" },
            Margin = new Thickness(16),
            Padding = new Thickness(22),
            Child = new StackPanel
            {
                Spacing = 14,
                Children =
                {
                    new StackPanel
                    {
                        Spacing = 2,
                        Children =
                        {
                            new TextBlock
                            {
                                Text = account.DisplayName,
                                FontSize = 12,
                                FontWeight = FontWeight.SemiBold,
                                Foreground = Palette.Info,
                            },
                            _stateText,
                        },
                    },
                    _spinner,
                    _messageText,
                    new Border
                    {
                        Padding = new Thickness(10, 6),
                        CornerRadius = new CornerRadius(6),
                        Background = Brush.Parse("#0A101D"),
                        BorderBrush = Brush.Parse("#1E2D4A"),
                        BorderThickness = new Thickness(1),
                        HorizontalAlignment = HorizontalAlignment.Left,
                        Child = new TextBlock
                        {
                            Text = route,
                            FontSize = 11,
                            FontWeight = FontWeight.Medium,
                            Foreground = account.ProxyMissing ? Palette.Danger : Palette.Ok,
                        },
                    },
                    new TextBlock
                    {
                        Text = force
                            ? "强制重登会清除该账号已保存的会话，登录完成前账号处于未登录状态。"
                            : "已有有效会话时不会清除登录态；关闭本窗口不会取消登录，任务会在后台继续。",
                        TextWrapping = TextWrapping.Wrap,
                        FontSize = 11,
                        Foreground = Palette.Faint,
                        LineHeight = 16,
                    },
                    _closeButton,
                },
            },
        };

        Opened += OnOpened;
        Closed += (_, _) => _cancellation.Cancel();
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        Opened -= OnOpened;
        AgentOperationDto? operation = null;
        var submitted = await _session.RunAsync(_force ? "强制重登" : "登录", async () =>
        {
            operation = await _session.CallAsync(
                "browser.startLogin",
                new AccountIdWithForceParams(_account.Id, _force),
                AppJsonContext.Default.AccountIdWithForceParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
        });

        if (!submitted || operation is null)
        {
            Apply("登录未能开始", "详细错误已显示在主窗口的提示中。", finished: true);
            return;
        }

        Apply(Describe(operation), DescribeMessage(operation), operation.IsTerminal);
        while (!operation.IsTerminal && !_cancellation.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(PollInterval, _cancellation.Token);
                operation = await _session.CallAsync(
                    "operations.get",
                    new IdParams(operation.Id),
                    AppJsonContext.Default.IdParams,
                    AppJsonContext.Default.AgentOperationDto);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception exception)
            {
                Apply("无法读取登录进度", exception.Message, finished: true);
                return;
            }
            Apply(Describe(operation), DescribeMessage(operation), operation.IsTerminal);
        }

        if (operation.State == "succeeded")
        {
            _session.Toasts.Success($"{_account.DisplayName} 登录成功");
        }
        else if (operation.IsTerminal && operation.State != "cancelled")
        {
            _session.Toasts.Error($"{_account.DisplayName} 登录{operation.StateText}：{operation.DetailText}");
        }
    }

    private static string Describe(AgentOperationDto operation) => operation.State switch
    {
        "queued" => "已排队，等待账号锁释放",
        "running" => operation.Stage == "launching" ? "正在启动 Chrome" : "正在检查登录状态",
        "waiting_user" => "请在打开的 Chrome 窗口里完成登录",
        "succeeded" => "登录成功",
        "failed" => "登录失败",
        "timed_out" => "登录超时",
        "cancelled" => "登录已取消",
        _ => operation.StateText,
    };

    private static string DescribeMessage(AgentOperationDto operation) =>
        operation.Error is not null
            ? $"[{operation.Error.Code}] {operation.Error.Message}"
            : operation.Message
                ?? "完成登录后 Agent 会自动确认会话并收起窗口。";

    private void Apply(string state, string message, bool finished)
    {
        Dispatcher.UIThread.Post(() =>
        {
            _stateText.Text = state;
            _messageText.Text = message;
            _spinner.IsIndeterminate = !finished;
            _spinner.IsVisible = !finished;
            _closeButton.Content = finished ? "完成并关闭" : "在后台继续";
        });
    }
}
