using Avalonia.Controls;
using Avalonia.Input;
using GptAccountKeeper.Desktop.Presentation.Pages;

namespace GptAccountKeeper.Desktop.Presentation.Views;

internal sealed partial class AccountsPage : UserControl
{
    public AccountsPage()
    {
        InitializeComponent();
    }

    /// <summary>
    /// 备注框按 Enter 直接提交并取消焦点。
    /// </summary>
    private void ClearFocus(Control control)
    {
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            // 普通优先级仍可能早于 TextBox/NumericUpDown 的按键收尾逻辑。
            // 在后台优先级移到零尺寸按钮；它是稳定的焦点目标，又不会绘制高亮。
            if (!FocusSink.Focus(NavigationMethod.Unspecified))
            {
                TopLevel.GetTopLevel(control)?.FocusManager?.Focus(null, NavigationMethod.Unspecified);
            }
        }, Avalonia.Threading.DispatcherPriority.Background);
    }

    private void OnNoteKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key is not (Key.Enter or Key.Return)) return;
        if (sender is not Control control || control.DataContext is not AccountRowViewModel row) return;
        e.Handled = true;
        row.CommitNoteCommand.Execute(null);
        ClearFocus(control);
    }

    private void OnWindowKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key is not (Key.Enter or Key.Return)) return;
        if (sender is not Control control || control.DataContext is not AccountRowViewModel row) return;
        e.Handled = true;
        if (row.HasPendingEdits)
        {
            row.CommitNoteCommand.Execute(null);
        }
        ClearFocus(control);
    }

    private void OnDropdownClosed(object? sender, EventArgs e)
    {
        // 搜索无匹配项时 AutoCompleteBox 也可能自行收起下拉层；保留输入焦点，
        // 只有真正选中了分组后才取消高亮。
        if (sender is AutoCompleteBox { SelectedItem: null }) return;
        if (sender is Control control)
        {
            ClearFocus(control);
        }
    }
}
