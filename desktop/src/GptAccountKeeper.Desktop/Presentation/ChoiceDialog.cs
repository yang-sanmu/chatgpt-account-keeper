using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

internal enum CloseChoice
{
    Cancel,
    HideToTray,
    ExitAll,
}

internal sealed record CloseChoiceResult(CloseChoice Choice, bool Remember);

internal sealed class CloseChoiceDialog : Window
{
    public CloseChoiceDialog()
    {
        Title = "关闭 ChatGPT Account Keeper";
        Width = 480;
        Height = 230;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White;

        var remember = new CheckBox { Content = "记住本次选择（以后可在设置中修改）" };
        var cancel = new Button { Content = "取消", Padding = new Thickness(14, 8) };
        cancel.Click += (_, _) => Close(new CloseChoiceResult(CloseChoice.Cancel, false));
        var hide = new Button { Content = "隐藏到托盘", Padding = new Thickness(14, 8) };
        hide.Click += (_, _) => Close(new CloseChoiceResult(CloseChoice.HideToTray, remember.IsChecked == true));
        var exit = new Button
        {
            Content = "退出全部",
            Padding = new Thickness(14, 8),
            Background = Brush.Parse("#B42318"),
            Foreground = Brushes.White,
        };
        exit.Click += (_, _) => Close(new CloseChoiceResult(CloseChoice.ExitAll, remember.IsChecked == true));

        Content = new StackPanel
        {
            Margin = new Thickness(24),
            Spacing = 16,
            Children =
            {
                new TextBlock
                {
                    Text = "后台任务应如何处理？",
                    FontSize = 20,
                    FontWeight = FontWeight.SemiBold,
                    Foreground = Brush.Parse("#101828"),
                },
                new TextBlock
                {
                    Text = "隐藏到托盘会保留 Agent、自动对话和巡检；退出全部会先检查正在使用的 Chrome 与关键任务，再安全停止 Agent。可在设置中记住默认行为。",
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = Brush.Parse("#475467"),
                },
                remember,
                new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 8,
                    Children = { cancel, hide, exit },
                },
            },
        };
    }
}

internal sealed class NoticeDialog : Window
{
    public NoticeDialog(string title, string message)
    {
        Title = title;
        Width = 500;
        Height = 230;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White;

        var close = new Button { Content = "知道了", Padding = new Thickness(16, 8) };
        close.Click += (_, _) => Close();
        Content = new StackPanel
        {
            Margin = new Thickness(24),
            Spacing = 16,
            Children =
            {
                new TextBlock
                {
                    Text = title,
                    FontSize = 20,
                    FontWeight = FontWeight.SemiBold,
                    Foreground = Brush.Parse("#101828"),
                },
                new TextBlock
                {
                    Text = message,
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = Brush.Parse("#475467"),
                },
                new StackPanel
                {
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Children = { close },
                },
            },
        };
    }
}

internal sealed class MigrationPreviewDialog : Window
{
    public MigrationPreviewDialog(LegacyMigrationProbeResult preview)
    {
        Title = "确认导入旧项目";
        Width = 620;
        Height = 520;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White;

        var cancel = new Button { Content = "取消", Padding = new Thickness(16, 8) };
        cancel.Click += (_, _) => Close(false);
        var import = new Button
        {
            Content = "开始复制并迁移",
            Padding = new Thickness(16, 8),
            Background = Brush.Parse("#175CD3"),
            Foreground = Brushes.White,
        };
        import.Click += (_, _) => Close(true);

        var counts = preview.Counts;
        var space = preview.AvailableBytes is long available
            ? $"需要至少 {FormatBytes(preview.RequiredBytes)}，目标盘可用 {FormatBytes(available)}"
            : $"需要至少 {FormatBytes(preview.RequiredBytes)}，无法读取目标盘可用空间";
        var warnings = new List<string>();
        if (preview.SelectedProfilesDirectory)
        {
            warnings.Add("你选择了 profiles 文件夹，程序已自动识别其父级旧项目目录。");
        }
        if (preview.EnoughSpace == false)
        {
            warnings.Add("目标磁盘空间不足，迁移不会开始。");
            import.IsEnabled = false;
        }
        if (preview.ActiveLocks.Length > 0)
        {
            warnings.Add($"检测到 {preview.ActiveLocks.Length} 个 Profile 留有 Chrome 运行锁。请先关闭旧程序和所有相关 Chrome；若是崩溃残留，确认没有 Chrome 进程后可重试。");
        }
        if (preview.RequiresTrashDecision)
        {
            warnings.Add("旧项目存在未完成的 Profile 删除暂存，本次迁移不会把暂存残留当作活动 Profile。旧目录不会被删除。");
        }

        Content = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,*,Auto"),
            Margin = new Thickness(26),
            Children =
            {
                new StackPanel
                {
                    Spacing = 7,
                    Children =
                    {
                        new TextBlock
                        {
                            Text = "旧项目扫描完成",
                            FontSize = 22,
                            FontWeight = FontWeight.SemiBold,
                            Foreground = Brush.Parse("#101828"),
                        },
                        new TextBlock
                        {
                            Text = preview.SourceRoot,
                            TextWrapping = TextWrapping.Wrap,
                            Foreground = Brush.Parse("#475467"),
                        },
                    },
                },
                BuildDetails(counts, preview, space, warnings, import),
                new StackPanel
                {
                    [Grid.RowProperty] = 2,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 9,
                    Children = { cancel, import },
                },
            },
        };
    }

    private static Control BuildDetails(
        LegacyMigrationCountsDto counts,
        LegacyMigrationProbeResult preview,
        string space,
        IReadOnlyList<string> warnings,
        Button importButton)
    {
        var panel = new StackPanel
        {
            [Grid.RowProperty] = 1,
            Margin = new Thickness(0, 22, 0, 22),
            Spacing = 11,
            Children =
            {
                new TextBlock { Text = $"账号 {counts.Accounts} · Profile {counts.Profiles} · 已归档 {counts.ArchivedProfiles}" },
                new TextBlock { Text = $"分组 {counts.Groups} · 会话集 {counts.ConversationSets} · 代理节点 {counts.ProxyNodes}" },
                new TextBlock { Text = $"状态 {counts.Statuses} · 历史 {counts.Histories} · 损坏历史行 {counts.Rejects}" },
                new TextBlock { Text = $"Profile 数据 {FormatBytes(preview.TotalProfileBytes)}" },
                new TextBlock { Text = space, FontWeight = FontWeight.SemiBold },
                new Border
                {
                    Padding = new Thickness(13),
                    CornerRadius = new CornerRadius(7),
                    Background = Brush.Parse("#F0F9FF"),
                    Child = new TextBlock
                    {
                        Text = "程序只复制旧数据，不移动、不覆盖、不删除旧项目。迁移完成前请不要启动旧服务或相关 Chrome。首次迁移后调度保持停止。",
                        TextWrapping = TextWrapping.Wrap,
                        Foreground = Brush.Parse("#175CD3"),
                    },
                },
            },
        };
        foreach (var warning in warnings)
        {
            panel.Children.Add(new TextBlock
            {
                Text = $"⚠ {warning}",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brush.Parse("#B54708"),
            });
        }
        if (preview.ActiveLocks.Length > 0)
        {
            importButton.IsEnabled = false;
            var confirmLocks = new CheckBox
            {
                Content = "我已确认旧服务及所有相关 Chrome 均已退出",
                Foreground = Brush.Parse("#B42318"),
            };
            confirmLocks.IsCheckedChanged += (_, _) =>
                importButton.IsEnabled = confirmLocks.IsChecked == true && preview.EnoughSpace != false;
            panel.Children.Add(confirmLocks);
        }
        return new ScrollViewer { Content = panel };
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var value = Math.Max(0, (double)bytes);
        var index = 0;
        while (value >= 1024 && index < units.Length - 1)
        {
            value /= 1024;
            index++;
        }
        return $"{value:0.##} {units[index]}";
    }
}

internal sealed class ConfirmationDialog : Window
{
    public ConfirmationDialog(string title, string message, bool destructive = false)
    {
        Title = title;
        Width = 520;
        Height = 260;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White;
        var cancel = new Button { Content = "取消", Padding = new Thickness(16, 8) };
        cancel.Click += (_, _) => Close(false);
        var confirm = new Button
        {
            Content = destructive ? "确认删除" : "确认",
            Padding = new Thickness(16, 8),
            Background = Brush.Parse(destructive ? "#B42318" : "#175CD3"),
            Foreground = Brushes.White,
        };
        confirm.Click += (_, _) => Close(true);
        Content = new StackPanel
        {
            Margin = new Thickness(26),
            Spacing = 17,
            Children =
            {
                new TextBlock { Text = title, FontSize = 21, FontWeight = FontWeight.SemiBold },
                new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Foreground = Brush.Parse("#475467") },
                new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 9,
                    Children = { cancel, confirm },
                },
            },
        };
    }
}

internal sealed class AccountRemovalDialog : Window
{
    public AccountRemovalDialog(AccountDto account)
    {
        Title = "删除账号";
        Width = 600;
        Height = 340;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White;
        var cancel = Button("取消", null, "#475467");
        var detach = Button("仅移除账号", "detach", "#175CD3");
        var archive = Button("移除并归档 Profile", "archive", "#B54708");
        var purge = Button("永久删除 Profile", "purge", "#B42318");
        Content = new StackPanel
        {
            Margin = new Thickness(26),
            Spacing = 15,
            Children =
            {
                new TextBlock { Text = "选择 Profile 的处理方式", FontSize = 21, FontWeight = FontWeight.SemiBold },
                new TextBlock
                {
                    Text = $"账号：{account.DisplayName}\n\n仅移除账号会保留 Profile 为孤儿；归档会把 Profile 移出活动目录；永久删除会清除其中全部登录态且不可恢复。运行中的账号不能删除。",
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = Brush.Parse("#475467"),
                },
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { cancel, detach, archive, purge } },
            },
        };

        Button Button(string text, string? result, string color)
        {
            var button = new Button
            {
                Content = text,
                Padding = new Thickness(12, 8),
                Background = Brush.Parse(color),
                Foreground = Brushes.White,
            };
            button.Click += (_, _) => Close(result);
            return button;
        }
    }
}
