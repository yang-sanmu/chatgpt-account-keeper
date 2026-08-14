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
    /// 备注框按 Enter 直接提交。旧网页面板是失焦保存；这里保留显式的“保存修改”按钮，
    /// 同时给键盘用户一条不用摸鼠标的路径。
    /// </summary>
    private void OnNoteKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key is not (Key.Enter or Key.Return)) return;
        if ((sender as Control)?.DataContext is not AccountRowViewModel row) return;
        e.Handled = true;
        row.CommitNoteCommand.Execute(null);
    }
}
