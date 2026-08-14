using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal sealed class SettingsPageViewModel : PageViewModel
{
    private readonly AgentSession _session;
    private readonly AppPaths _paths;
    private readonly EditableField<double> _intervalMinutes = new(180);
    private readonly EditableField<double> _jitterMinutes = new(30);
    private readonly EditableField<double> _statusCheckMinutes = new(15);
    private readonly EditableField<double> _openPageTimeoutMinutes = new(0);
    private readonly EditableField<bool> _headless = new(true);
    private readonly EditableField<bool> _statusCheckOnStartup = new(true);
    private readonly EditableField<bool> _profileAutoClean = new(true);

    public SettingsPageViewModel(AgentSession session, AppPaths paths)
        : base("settings", "⚙", "设置", "调度、风控、桌面行为与更新")
    {
        _session = session;
        _paths = paths;
        SaveAgentSettingsCommand = new AsyncRelayCommand(SaveAsync, () => HasPendingEdits);
        RevertAgentSettingsCommand = new AsyncRelayCommand(RevertAsync, () => HasPendingEdits);
        OpenDataDirectoryCommand = new AsyncRelayCommand(() => Reveal(_paths.DataDirectory));
        OpenLogFileCommand = new AsyncRelayCommand(() => Reveal(_paths.AgentLogFile));
        CopyDataDirectoryCommand = new AsyncRelayCommand(() => CopyAsync(_paths.DataDirectory, "数据目录"));
        CopyLogPathCommand = new AsyncRelayCommand(() => CopyAsync(_paths.AgentLogFile, "日志路径"));
    }

    public ObservableCollection<CloseBehaviorOptionViewModel> CloseBehaviorOptions { get; } = [];

    public ObservableCollection<UpdatePolicyOptionViewModel> UpdatePolicyOptions { get; } = [];

    public ICommand SaveAgentSettingsCommand { get; }
    public ICommand RevertAgentSettingsCommand { get; }
    public ICommand OpenDataDirectoryCommand { get; }
    public ICommand OpenLogFileCommand { get; }
    public ICommand CopyDataDirectoryCommand { get; }
    public ICommand CopyLogPathCommand { get; }

    /// <summary>“打开所在文件夹”和“复制路径”由窗口实现，避免 ViewModel 依赖顶层控件。</summary>
    public Func<string, Task>? RevealRequested { get; set; }

    public Func<string, Task>? CopyRequested { get; set; }

    /// <summary>桌面侧设置（关闭行为、开机启动、更新策略）由 Shell 持有并持久化。</summary>
    public DesktopBehaviorViewModel? Behavior { get; set; }

    public string DataDirectory => _paths.DataDirectory;

    public string AgentLogFile => _paths.AgentLogFile;

    public string RuntimeMode => _paths.IsDevelopment
        ? "开发模式：使用独立数据目录和 IPC 通道，Agent 来自当前仓库"
        : "安装模式：使用随应用携带的私有 Agent";

    public double IntervalMinutes
    {
        get => _intervalMinutes.Value;
        set => SetField(_intervalMinutes, value);
    }

    public double JitterMinutes
    {
        get => _jitterMinutes.Value;
        set => SetField(_jitterMinutes, value);
    }

    public double StatusCheckMinutes
    {
        get => _statusCheckMinutes.Value;
        set => SetField(_statusCheckMinutes, value);
    }

    public double OpenPageTimeoutMinutes
    {
        get => _openPageTimeoutMinutes.Value;
        set => SetField(_openPageTimeoutMinutes, value);
    }

    public bool Headless
    {
        get => _headless.Value;
        set => SetField(_headless, value);
    }

    public bool StatusCheckOnStartup
    {
        get => _statusCheckOnStartup.Value;
        set => SetField(_statusCheckOnStartup, value);
    }

    public bool ProfileAutoCleanEnabled
    {
        get => _profileAutoClean.Value;
        set => SetField(_profileAutoClean, value);
    }

    public bool HasPendingEdits =>
        _intervalMinutes.IsDirty || _jitterMinutes.IsDirty || _statusCheckMinutes.IsDirty
        || _openPageTimeoutMinutes.IsDirty || _headless.IsDirty || _statusCheckOnStartup.IsDirty
        || _profileAutoClean.IsDirty;

    public string PendingEditText => HasPendingEdits ? "有未保存的修改" : "已与 Agent 同步";

    public string ValidationError => IntervalMinutes < 1
        ? "账号执行间隔必须大于 0 分钟"
        : JitterMinutes < 0
            ? "随机抖动不能为负数"
            : StatusCheckMinutes < 1
                ? "状态巡检间隔必须大于 0 分钟"
                : OpenPageTimeoutMinutes < 0
                    ? "打开网页兜底超时不能为负数"
                    : string.Empty;

    public bool HasValidationError => ValidationError.Length > 0;

    /// <summary>
    /// 应用 Agent 返回的设置。脏字段保留用户输入：设置页停留时间长，
    /// 一次 settings.changed 事件不该把正在填的数字冲掉。
    /// </summary>
    public void ApplyAgentSettings(AgentSettingsDto settings)
    {
        if (_intervalMinutes.Refresh(settings.IntervalMinutes)) OnPropertyChanged(nameof(IntervalMinutes));
        if (_jitterMinutes.Refresh(settings.JitterMinutes)) OnPropertyChanged(nameof(JitterMinutes));
        if (_statusCheckMinutes.Refresh(settings.StatusCheckMinutes)) OnPropertyChanged(nameof(StatusCheckMinutes));
        if (_openPageTimeoutMinutes.Refresh(settings.OpenPageTimeoutMinutes)) OnPropertyChanged(nameof(OpenPageTimeoutMinutes));
        if (_headless.Refresh(settings.Headless)) OnPropertyChanged(nameof(Headless));
        if (_statusCheckOnStartup.Refresh(settings.StatusCheckOnStartup)) OnPropertyChanged(nameof(StatusCheckOnStartup));
        if (_profileAutoClean.Refresh(settings.ProfileAutoCleanEnabled)) OnPropertyChanged(nameof(ProfileAutoCleanEnabled));
        RaiseEditState();
    }

    private void SetField<T>(EditableField<T> field, T value)
    {
        field.Value = value;
        OnPropertyChanged();
        RaiseEditState();
    }

    private void RaiseEditState()
    {
        OnPropertyChanged(nameof(HasPendingEdits));
        OnPropertyChanged(nameof(PendingEditText));
        OnPropertyChanged(nameof(ValidationError));
        OnPropertyChanged(nameof(HasValidationError));
        (SaveAgentSettingsCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (RevertAgentSettingsCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
    }

    private async Task SaveAsync()
    {
        if (HasValidationError)
        {
            _session.Toasts.Error(ValidationError);
            return;
        }
        await _session.RunAsync("保存 Agent 设置", async () =>
        {
            var saved = await _session.CallAsync(
                "settings.update",
                new SettingsUpdateParams(new AgentSettingsPatchDto
                {
                    IntervalMinutes = IntervalMinutes,
                    JitterMinutes = JitterMinutes,
                    Headless = Headless,
                    StatusCheckMinutes = StatusCheckMinutes,
                    StatusCheckOnStartup = StatusCheckOnStartup,
                    OpenPageTimeoutMinutes = OpenPageTimeoutMinutes,
                    ProfileAutoCleanEnabled = ProfileAutoCleanEnabled,
                }),
                AppJsonContext.Default.SettingsUpdateParams,
                AppJsonContext.Default.AgentSettingsDto,
                AgentSession.NewCommandId());
            _intervalMinutes.Commit(saved.IntervalMinutes);
            _jitterMinutes.Commit(saved.JitterMinutes);
            _statusCheckMinutes.Commit(saved.StatusCheckMinutes);
            _openPageTimeoutMinutes.Commit(saved.OpenPageTimeoutMinutes);
            _headless.Commit(saved.Headless);
            _statusCheckOnStartup.Commit(saved.StatusCheckOnStartup);
            _profileAutoClean.Commit(saved.ProfileAutoCleanEnabled);
            RaiseEditState();
        }, "Agent 设置已保存，状态巡检已按新间隔重启");
    }

    private Task RevertAsync()
    {
        _intervalMinutes.Revert();
        _jitterMinutes.Revert();
        _statusCheckMinutes.Revert();
        _openPageTimeoutMinutes.Revert();
        _headless.Revert();
        _statusCheckOnStartup.Revert();
        _profileAutoClean.Revert();
        OnPropertyChanged(nameof(IntervalMinutes));
        OnPropertyChanged(nameof(JitterMinutes));
        OnPropertyChanged(nameof(StatusCheckMinutes));
        OnPropertyChanged(nameof(OpenPageTimeoutMinutes));
        OnPropertyChanged(nameof(Headless));
        OnPropertyChanged(nameof(StatusCheckOnStartup));
        OnPropertyChanged(nameof(ProfileAutoCleanEnabled));
        RaiseEditState();
        _session.Toasts.Info("已放弃未保存的设置修改");
        return Task.CompletedTask;
    }

    private async Task Reveal(string path)
    {
        if (RevealRequested is null) return;
        await RevealRequested(path);
    }

    private async Task CopyAsync(string value, string label)
    {
        if (CopyRequested is null) return;
        await CopyRequested(value);
        _session.Toasts.Success($"{label}已复制到剪贴板");
    }
}
