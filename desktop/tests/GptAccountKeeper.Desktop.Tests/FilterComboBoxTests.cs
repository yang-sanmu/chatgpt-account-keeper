using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using GptAccountKeeper.Desktop.Presentation;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

/// <summary>
/// 过滤下拉框的两条常规行为。原生 AutoCompleteBox 都不满足：点击只聚焦不展开，
/// 过滤又拿当前文本匹配，于是选中一项后只能匹配到它自己 —— 合起来就是用户报的
/// "必须先删掉文本框里的内容才看得到下拉列表"。
/// </summary>
public sealed class FilterComboBoxTests
{
    [Fact]
    public void ClickingTheBoxOpensTheDropDown()
    {
        var box = NewBox();
        Assert.False(box.IsDropDownOpen);

        PressLeftButton(box);

        Assert.True(box.IsDropDownOpen);
    }

    [Fact]
    public void RightClickDoesNotOpenTheDropDown()
    {
        var box = NewBox();

        box.RaiseEvent(new PointerPressedEventArgs(
            box,
            new Pointer(1, PointerType.Mouse, true),
            box,
            new Point(1, 1),
            0,
            new PointerPointProperties(RawInputModifiers.RightMouseButton, PointerUpdateKind.RightButtonPressed),
            KeyModifiers.None));

        Assert.False(box.IsDropDownOpen);
    }

    [Fact]
    public void ADisabledBoxStaysClosed()
    {
        var box = NewBox();
        box.IsEnabled = false;

        PressLeftButton(box);

        Assert.False(box.IsDropDownOpen);
    }

    /// <summary>
    /// 刚点开时文本框里还是当前选中项的标题，此时必须展示全部选项。内置 Contains
    /// 过滤在这一刻只会留下选中项自己。
    /// </summary>
    [Fact]
    public void EveryChoiceIsListedWhileTheTextStillEqualsTheSelectedTitle()
    {
        var box = NewBox();
        var japan = new RouteChoiceViewModel("jp", "日本节点");
        box.SelectedItem = japan;

        Assert.True(box.ShowsEveryChoice("日本节点"));
        foreach (var choice in Choices())
        {
            Assert.True(box.MatchesQuery("日本节点", choice), $"{choice.Title} 应当仍在列表里");
        }
    }

    [Fact]
    public void EveryChoiceIsListedWhenTheTextIsEmpty()
    {
        var box = NewBox();
        box.SelectedItem = new RouteChoiceViewModel("jp", "日本节点");

        Assert.True(box.ShowsEveryChoice(string.Empty));
        Assert.True(box.ShowsEveryChoice(null));
        Assert.True(box.MatchesQuery(string.Empty, new RouteChoiceViewModel("us", "美国节点")));
    }

    /// <summary>改成别的内容之后才开始过滤，且大小写不敏感。</summary>
    [Fact]
    public void EditingTheTextFiltersTheChoices()
    {
        var box = NewBox();
        box.SelectedItem = new RouteChoiceViewModel("jp", "日本节点");

        Assert.False(box.ShowsEveryChoice("美国"));
        Assert.True(box.MatchesQuery("美国", new RouteChoiceViewModel("us", "美国节点")));
        Assert.False(box.MatchesQuery("美国", new RouteChoiceViewModel("jp", "日本节点")));

        Assert.True(box.MatchesQuery("europe", new RouteChoiceViewModel("eu", "Europe Stable")));
        Assert.True(box.MatchesQuery("EUROPE", new RouteChoiceViewModel("eu", "Europe Stable")));
    }

    /// <summary>
    /// 过滤要走自定义谓词。XAML 里再写一次 FilterMode 就会把内置 TextFilter 装回去，
    /// 过滤又变成"按当前文本匹配"，这两个属性是互相覆盖的。
    /// </summary>
    [Fact]
    public void FilteringUsesTheCustomPredicateAndListsFromTheFirstKeystroke()
    {
        var box = NewBox();

        Assert.Equal(AutoCompleteFilterMode.Custom, box.FilterMode);
        Assert.NotNull(box.ItemFilter);
        // 默认值 1 会让空文本直接收起下拉层。
        Assert.Equal(0, box.MinimumPrefixLength);
    }

    /// <summary>不覆盖 StyleKey 的话子类找不到 Fluent 的模板，控件整个不显示。</summary>
    [Fact]
    public void TheControlKeepsTheAutoCompleteBoxThemeKey()
    {
        Assert.Equal(typeof(AutoCompleteBox), NewBox().StyleKey);
    }

    /// <summary>
    /// 输入几个字筛选、不点候选项就直接去点"保存"：AutoCompleteBox 会因为文本不是
    /// 任何一项的精确文本而把 SelectedItem 置空，于是静默存成不分组 / 系统网络。
    /// 失焦时必须退回上一次的选择。
    /// </summary>
    [Fact]
    public void LeavingAHalfTypedFilterKeepsThePreviousSelection()
    {
        var box = NewBox();
        var japan = box.ItemsSource!.Cast<RouteChoiceViewModel>().Single(choice => choice.Id == "jp");
        box.SelectedItem = japan;

        // 半途输入让控件自己清掉了选择。
        box.SelectedItem = null;
        Assert.Null(box.SelectedItem);

        LoseFocus(box);

        Assert.Same(japan, box.SelectedItem);
    }

    /// <summary>选项已经不在列表里（分组被删、节点失效）时不能退回到它。</summary>
    [Fact]
    public void AChoiceThatNoLongerExistsIsNotRestored()
    {
        var box = NewBox();
        box.SelectedItem = box.ItemsSource!.Cast<RouteChoiceViewModel>().Single(choice => choice.Id == "jp");
        box.SelectedItem = null;
        box.ItemsSource = new RouteChoiceViewModel[] { new(null, "系统网络") };

        LoseFocus(box);

        Assert.Null(box.SelectedItem);
    }

    private static void LoseFocus(FilterComboBox box) =>
        box.RaiseEvent(new FocusChangedEventArgs(InputElement.LostFocusEvent));

    private static FilterComboBox NewBox() => new() { ItemsSource = Choices() };

    private static RouteChoiceViewModel[] Choices() =>
    [
        new(null, "系统网络"),
        new("jp", "日本节点"),
        new("us", "美国节点"),
        new("eu", "Europe Stable"),
    ];

    private static void PressLeftButton(FilterComboBox box) =>
        box.RaiseEvent(new PointerPressedEventArgs(
            box,
            new Pointer(1, PointerType.Mouse, true),
            box,
            new Point(1, 1),
            0,
            new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed),
            KeyModifiers.None));
}
