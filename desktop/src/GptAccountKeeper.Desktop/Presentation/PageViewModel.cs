namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 一个导航页。
///
/// 早先八个页面是同一个 StackPanel 的兄弟节点，靠 IsVisible 切换：所有控件在启动时
/// 全部实例化并保持绑定活跃，列表写死 MinHeight 又套在外层 ScrollViewer 里造成嵌套
/// 滚动，切页也不重置滚动位置。现在每页是独立的 UserControl + ViewModel，由 Shell
/// 按需承载。
/// </summary>
internal abstract class PageViewModel : ObservableObject
{
    protected PageViewModel(string key, string glyph, string title, string description)
    {
        Key = key;
        Glyph = glyph;
        Title = title;
        Description = description;
    }

    public string Key { get; }

    public string Glyph { get; }

    public string Title { get; }

    public string Description { get; }

    /// <summary>页面被选中时调用。用于首次进入时的懒加载（例如 Profile 扫描）。</summary>
    public virtual Task ActivateAsync() => Task.CompletedTask;
}
