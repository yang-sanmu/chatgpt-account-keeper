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
        Width = 500;
        Height = 250;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Palette.BgDark;

        var remember = new CheckBox { Content = "记住本次选择（以后可在设置中修改）", Margin = new Thickness(0, 4) };
        var cancel = new Button { Content = "取消", Padding = new Thickness(16, 8) };
        cancel.Click += (_, _) => Close(new CloseChoiceResult(CloseChoice.Cancel, false));
        var hide = new Button
        {
            Content = "隐藏到托盘",
            Padding = new Thickness(16, 8),
            Classes = { "primary" },
        };
        hide.Click += (_, _) => Close(new CloseChoiceResult(CloseChoice.HideToTray, remember.IsChecked == true));
        var exit = new Button
        {
            Content = "退出全部",
            Padding = new Thickness(16, 8),
            Classes = { "danger" },
        };
        exit.Click += (_, _) => Close(new CloseChoiceResult(CloseChoice.ExitAll, remember.IsChecked == true));

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
                    new TextBlock
                    {
                        Text = "后台任务应如何处理？",
                        FontSize = 18,
                        FontWeight = FontWeight.Bold,
                        Foreground = Palette.TextPrimary,
                    },
                    new TextBlock
                    {
                        Text = "隐藏到托盘会保留 Agent、自动对话和巡检；退出全部会请求 Agent 关闭本程序管理的 Chrome、结束任务并完成数据库检查点，未能在数秒内收尾的任务会被中止。可在设置中记住默认行为。",
                        TextWrapping = TextWrapping.Wrap,
                        Foreground = Palette.TextSecondary,
                        LineHeight = 18,
                        FontSize = 12,
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
            },
        };
    }
}

internal sealed class NoticeDialog : Window
{
    public NoticeDialog(string title, string message)
    {
        Title = title;
        Width = 520;
        Height = 250;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Palette.BgDark;

        var close = new Button { Content = "知道了", Classes = { "primary" }, Padding = new Thickness(18, 8) };
        close.Click += (_, _) => Close();
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
                    new TextBlock
                    {
                        Text = title,
                        FontSize = 18,
                        FontWeight = FontWeight.Bold,
                        Foreground = Palette.TextPrimary,
                    },
                    new TextBlock
                    {
                        Text = message,
                        TextWrapping = TextWrapping.Wrap,
                        Foreground = Palette.TextSecondary,
                        LineHeight = 18,
                        FontSize = 12,
                    },
                    new StackPanel
                    {
                        HorizontalAlignment = HorizontalAlignment.Right,
                        Children = { close },
                    },
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
        Width = 640;
        Height = 540;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Palette.BgDark;

        var cancel = new Button { Content = "取消", Padding = new Thickness(16, 8) };
        cancel.Click += (_, _) => Close(false);
        var import = new Button
        {
            Content = "开始复制并迁移",
            Padding = new Thickness(16, 8),
            Classes = { "primary" },
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

        Content = new Border
        {
            Classes = { "card" },
            Margin = new Thickness(16),
            Padding = new Thickness(22),
            Child = new Grid
            {
                RowDefinitions = new RowDefinitions("Auto,*,Auto"),
                Children =
                {
                    new StackPanel
                    {
                        Spacing = 6,
                        Children =
                        {
                            new TextBlock
                            {
                                Text = "旧项目扫描完成",
                                FontSize = 20,
                                FontWeight = FontWeight.Bold,
                                Foreground = Palette.TextPrimary,
                            },
                            new TextBlock
                            {
                                Text = preview.SourceRoot,
                                TextWrapping = TextWrapping.Wrap,
                                Foreground = Palette.TextSecondary,
                                FontSize = 12,
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
            Margin = new Thickness(0, 16, 0, 16),
            Spacing = 8,
            Children =
            {
                new TextBlock { Text = $"账号 {counts.Accounts} · Profile {counts.Profiles} · 已归档 {counts.ArchivedProfiles}", Foreground = Palette.TextPrimary },
                new TextBlock { Text = $"分组 {counts.Groups} · 会话集 {counts.ConversationSets} · 代理节点 {counts.ProxyNodes}", Foreground = Palette.TextPrimary },
                new TextBlock { Text = $"状态 {counts.Statuses} · 历史 {counts.Histories} · 损坏历史行 {counts.Rejects}", Foreground = Palette.TextPrimary },
                new TextBlock { Text = $"Profile 数据 {FormatBytes(preview.TotalProfileBytes)}", Foreground = Palette.Info },
                new TextBlock { Text = space, FontWeight = FontWeight.SemiBold, Foreground = Palette.Ok },
                new Border
                {
                    Padding = new Thickness(12),
                    CornerRadius = new CornerRadius(8),
                    Background = Brush.Parse("#0F243E"),
                    BorderBrush = Brush.Parse("#1D4ED8"),
                    BorderThickness = new Thickness(1),
                    Child = new TextBlock
                    {
                        Text = "程序只复制旧数据，不移动、不覆盖、不删除旧项目。迁移完成前请不要启动旧服务或相关 Chrome。首次迁移后调度保持停止。",
                        TextWrapping = TextWrapping.Wrap,
                        Foreground = Brush.Parse("#93C5FD"),
                        FontSize = 11,
                        LineHeight = 16,
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
                Foreground = Palette.Warning,
                FontSize = 11,
            });
        }
        if (preview.ActiveLocks.Length > 0)
        {
            importButton.IsEnabled = false;
            var confirmLocks = new CheckBox
            {
                Content = "我已确认旧服务及所有相关 Chrome 均已退出",
                Foreground = Palette.Danger,
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
        Background = Palette.BgDark;
        var cancel = new Button { Content = "取消", Padding = new Thickness(16, 8) };
        cancel.Click += (_, _) => Close(false);
        var confirm = new Button
        {
            Content = destructive ? "确认删除" : "确认",
            Padding = new Thickness(16, 8),
            Classes = { destructive ? "danger" : "primary" },
        };
        confirm.Click += (_, _) => Close(true);
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
                    new TextBlock { Text = title, FontSize = 18, FontWeight = FontWeight.Bold, Foreground = Palette.TextPrimary },
                    new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Foreground = Palette.TextSecondary, FontSize = 12, LineHeight = 18 },
                    new StackPanel
                    {
                        Orientation = Orientation.Horizontal,
                        HorizontalAlignment = HorizontalAlignment.Right,
                        Spacing = 9,
                        Children = { cancel, confirm },
                    },
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
        Width = 620;
        Height = 330;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Palette.BgDark;
        var cancel = Button("取消", null, false, false);
        var detach = Button("仅移除账号", "detach", false, false);
        var archive = Button("移除并归档 Profile", "archive", true, false);
        var purge = Button("永久删除 Profile", "purge", false, true);
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
                    new TextBlock { Text = "选择 Profile 的处理方式", FontSize = 18, FontWeight = FontWeight.Bold, Foreground = Palette.TextPrimary },
                    new TextBlock
                    {
                        Text = $"账号：{account.DisplayName}\n\n仅移除账号会保留 Profile 为孤儿；归档会把 Profile 移出活动目录；永久删除会清除其中全部登录态且不可恢复。运行中的账号不能删除。",
                        TextWrapping = TextWrapping.Wrap,
                        Foreground = Palette.TextSecondary,
                        FontSize = 12,
                        LineHeight = 18,
                    },
                    new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, detach, archive, purge } },
                },
            },
        };

        Button Button(string text, string? result, bool isWarn, bool isDanger)
        {
            var button = new Button
            {
                Content = text,
                Padding = new Thickness(12, 8),
            };
            if (isWarn) button.Classes.Add("warn");
            else if (isDanger) button.Classes.Add("danger");
            button.Click += (_, _) => Close(result);
            return button;
        }
    }
}
