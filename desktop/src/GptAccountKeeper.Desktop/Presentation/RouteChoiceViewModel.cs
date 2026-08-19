namespace GptAccountKeeper.Desktop.Presentation;

internal sealed record RouteChoiceViewModel(string? Id, string Title)
{
    // AutoCompleteBox 的内置 Contains 会以项目的字符串值做匹配。
    // record 默认 ToString 会包含类型名与字段名，常见字母会让几乎所有分组误匹配。
    public override string ToString() => Title;
}
