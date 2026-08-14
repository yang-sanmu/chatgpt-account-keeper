using System.Collections.Concurrent;
using Avalonia.Media;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 状态色板。
///
/// 视图模型直接暴露 <see cref="IBrush"/> 而不是颜色字符串：字符串到 Brush 的隐式
/// 转换依赖运行时 TypeConverter，在 PublishTrimmed/AOT 下不可靠。Brush 实例按 hex
/// 缓存并冻结，重复绑定不会反复分配。
/// </summary>
internal static class Palette
{
    private static readonly ConcurrentDictionary<string, IBrush> Cache = new(StringComparer.Ordinal);

    public static readonly IBrush Ok = Of("#027A48");
    public static readonly IBrush Warning = Of("#B54708");
    public static readonly IBrush Danger = Of("#B42318");
    public static readonly IBrush Info = Of("#175CD3");
    public static readonly IBrush Muted = Of("#667085");
    public static readonly IBrush Faint = Of("#98A2B3");

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
