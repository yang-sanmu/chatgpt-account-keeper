using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 可过滤的选择下拉框。
///
/// 原生 AutoCompleteBox 的两点行为都不符合常规过滤下拉框：点击只会聚焦文本框，
/// 下拉层要等文本变化才弹；而过滤又是拿当前文本去匹配，选中一项之后文本正好等于
/// 该项标题，于是只能匹配到它自己。两者叠加的结果就是"必须先把文本删空才看得到
/// 列表"。这里改成：点击即展开全部选项，只有把文本改成别的内容之后才开始过滤。
///
/// 选项的 ToString() 必须是显示文本（见 <see cref="RouteChoiceViewModel"/>）：
/// 过滤和文本回填都以它为准。
/// </summary>
internal sealed class FilterComboBox : AutoCompleteBox
{
    public FilterComboBox()
    {
        // 必须在隧道阶段处理：模板里的 PART_TextBox 会把 PointerPressed 标记为已处理，
        // 冒泡回到这里时就再也看不到这一次按下了。
        AddHandler(PointerPressedEvent, OnPointerPressedTunnel, RoutingStrategies.Tunnel, handledEventsToo: true);

        // ItemFilter 与 FilterMode 会互相覆盖：设 ItemFilter 会把 FilterMode 切成 Custom，
        // 而任何一处再写 FilterMode="Contains" 都会把内置 TextFilter 装回去，过滤又变成
        // "按当前文本匹配"。所以这两个都由控件自己定，XAML 不再设置。
        ItemFilter = MatchesQuery;

        // 文本为空时也要弹出完整列表。默认值 1 会让空文本直接收起下拉层。
        MinimumPrefixLength = 0;
    }

    /// <summary>
    /// 最后一次真正选中的项。AutoCompleteBox 在文本不是某一项的精确文本时会把
    /// SelectedItem 置空，所以"输入几个字筛选、然后直接去点保存"会静默把选择清掉，
    /// 落库成不分组 / 系统网络。这里记住它，失焦时补回去。
    /// </summary>
    private object? _lastSelected;

    /// <summary>
    /// 主题和样式都以 AutoCompleteBox 为键。不覆盖 StyleKey 的话子类既找不到
    /// Fluent 的 ControlTheme（没有模板，控件整个不显示），也套不上 App.axaml 的样式。
    /// </summary>
    protected override Type StyleKeyOverride => typeof(AutoCompleteBox);

    /// <summary>
    /// 展示全部选项的两种情形：文本为空，或文本仍是当前选中项的标题（点开但还没改动）。
    /// </summary>
    internal bool ShowsEveryChoice(string? query) =>
        string.IsNullOrEmpty(query)
        || string.Equals(query, DisplayTextOf(SelectedItem ?? _lastSelected), StringComparison.Ordinal);

    internal bool MatchesQuery(string? query, object? item) =>
        ShowsEveryChoice(query)
        || DisplayTextOf(item)?.Contains(query!, StringComparison.CurrentCultureIgnoreCase) == true;

    private static string? DisplayTextOf(object? item) => item?.ToString();

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == SelectedItemProperty && change.GetNewValue<object?>() is { } selected)
        {
            _lastSelected = selected;
        }
    }

    /// <summary>
    /// 失焦时把没落地的输入退回到上一次的选择。否则"输入几个字筛选、不点候选项就去点
    /// 保存"会把选择静默清空 —— 界面上还显示着输入的文字，存进去的却是不分组。
    /// </summary>
    protected override void OnLostFocus(FocusChangedEventArgs e)
    {
        base.OnLostFocus(e);
        if (IsKeyboardFocusWithin || SelectedItem is not null) return;
        // 选项可能已经不在列表里了（分组被删、节点失效），那就不该退回到它。
        if (_lastSelected is null || ItemsSource?.Cast<object>().Contains(_lastSelected) != true) return;
        SetCurrentValue(SelectedItemProperty, _lastSelected);
    }

    private void OnPointerPressedTunnel(object? sender, PointerPressedEventArgs e)
    {
        if (!IsEnabled || IsDropDownOpen) return;
        // 右键要留给文本框的上下文菜单；触摸按下同样报告为左键。
        if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) return;
        SetCurrentValue(IsDropDownOpenProperty, true);
    }
}
