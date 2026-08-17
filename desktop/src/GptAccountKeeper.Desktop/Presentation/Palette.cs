using System.Collections.Concurrent;
using Avalonia.Media;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 状态色板 (Modern Slate Design System)。
///
/// 视图模型直接暴露 <see cref="IBrush"/> 而不是颜色字符串：字符串到 Brush 的隐式
/// 转换依赖运行时 TypeConverter，在 PublishTrimmed/AOT 下不可靠。Brush 实例按 hex
/// 缓存并冻结，重复绑定不会反复分配。
/// </summary>
internal static class Palette
{
    private static readonly ConcurrentDictionary<string, IBrush> Cache = new(StringComparer.Ordinal);

    // 状态色彩 (统一采用与 Web 端一致的现代 Slate 语义色)
    public static readonly IBrush Ok = Of("#10B981");         // 翡翠绿
    public static readonly IBrush Warning = Of("#F59E0B");    // 琥珀橙
    public static readonly IBrush Danger = Of("#EF4444");     // 珊瑚红
    public static readonly IBrush Info = Of("#3B82F6");       // 电光蓝
    public static readonly IBrush Muted = Of("#94A3B8");      // 灰阶中性
    public static readonly IBrush Faint = Of("#64748B");      // 暗灰浅色

    // 基础主题色彩
    public static readonly IBrush BgDark = Of("#0B0F19");
    public static readonly IBrush BgCard = Of("#131C2E");
    public static readonly IBrush BgElevated = Of("#1E293B");
    public static readonly IBrush BorderDark = Of("#1E2D4A");
    public static readonly IBrush TextPrimary = Of("#F8FAFC");
    public static readonly IBrush TextSecondary = Of("#94A3B8");
    public static readonly IBrush TextMuted = Of("#64748B");

    public static IBrush Of(string hex)
    {
        return Cache.GetOrAdd(hex, static value =>
        {
            var brush = new SolidColorBrush(Color.Parse(value));
            brush.ToImmutable();
            return brush.ToImmutable();
        });
    }
}
