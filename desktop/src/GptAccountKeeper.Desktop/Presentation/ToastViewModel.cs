using System.Collections.ObjectModel;
using Avalonia.Media;
using Avalonia.Threading;

namespace GptAccountKeeper.Desktop.Presentation;

internal enum ToastKind
{
    Info,
    Success,
    Error,
}

internal sealed class ToastViewModel : ObservableObject
{
    private string _message = string.Empty;

    public ToastViewModel(ToastKind kind, string message)
    {
        Kind = kind;
        Message = message;
    }

    public ToastKind Kind { get; }

    public string Message
    {
        get => _message;
        private set => SetProperty(ref _message, value);
    }

    public string Glyph => Kind switch
    {
        ToastKind.Success => "✔",
        ToastKind.Error => "✖",
        _ => "ℹ",
    };

    // 直接暴露 Brush：字符串到 Brush 依赖运行时 TypeConverter，在 AOT/裁剪下不可靠。
    public IBrush Background => Kind switch
    {
        ToastKind.Success => Palette.Of("#064E3B"),
        ToastKind.Error => Palette.Of("#450A0A"),
        _ => Palette.Of("#0F2942"),
    };

    public IBrush BorderColor => Kind switch
    {
        ToastKind.Success => Palette.Of("#059669"),
        ToastKind.Error => Palette.Of("#DC2626"),
        _ => Palette.Of("#0284C7"),
    };

    public IBrush Foreground => Kind switch
    {
        ToastKind.Success => Palette.Of("#6EE7B7"),
        ToastKind.Error => Palette.Of("#FCA5A5"),
        _ => Palette.Of("#7DD3FC"),
    };
}

/// <summary>
/// 窗口顶层的操作反馈。
///
/// 早先唯一的反馈通道是页面最底部一个 TextBlock：账号页第一屏根本看不到它，
/// 点"立即运行"界面上什么都不动。这里把反馈提到窗口顶层浮层，并保留一份
/// 历史文本供"最近动作"显示。
/// </summary>
internal sealed class ToastHost : ObservableObject
{
    private static readonly TimeSpan SuccessLifetime = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ErrorLifetime = TimeSpan.FromSeconds(8);
    private readonly Action<ToastViewModel, TimeSpan> _schedule;
    private string _lastMessage = "连接 Agent 后将载入账号数据";

    public ToastHost(Action<ToastViewModel, TimeSpan>? schedule = null)
    {
        // 测试里没有 Avalonia 计时器，注入一个同步实现即可。
        _schedule = schedule ?? DefaultSchedule;
    }

    public ObservableCollection<ToastViewModel> Items { get; } = [];

    /// <summary>最近一次动作的文本。状态栏用它，不再承担主要反馈职责。</summary>
    public string LastMessage
    {
        get => _lastMessage;
        private set => SetProperty(ref _lastMessage, value);
    }

    public void Info(string message) => Show(ToastKind.Info, message);

    public void Success(string message) => Show(ToastKind.Success, message);

    /// <summary>失败提示停留更久：用户需要时间读错误码。</summary>
    public void Error(string message) => Show(ToastKind.Error, message);

    public void Show(ToastKind kind, string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;
        LastMessage = message;
        var toast = new ToastViewModel(kind, message);
        Items.Insert(0, toast);
        // 同一时刻最多留 4 条，避免批量操作把界面刷满。
        while (Items.Count > 4) Items.RemoveAt(Items.Count - 1);
        _schedule(toast, kind == ToastKind.Error ? ErrorLifetime : SuccessLifetime);
    }

    public void Dismiss(ToastViewModel toast) => Items.Remove(toast);

    private void DefaultSchedule(ToastViewModel toast, TimeSpan lifetime)
    {
        DispatcherTimer.RunOnce(() => Items.Remove(toast), lifetime);
    }
}
