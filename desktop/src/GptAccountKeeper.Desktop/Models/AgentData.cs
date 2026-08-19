using System.Text.Json;
using System.Text.Json.Serialization;
using Avalonia.Media;
using GptAccountKeeper.Desktop.Presentation;

namespace GptAccountKeeper.Desktop.Models;

internal sealed record EmptyParams;

internal sealed class AgentBootstrapResult
{
    [JsonPropertyName("instanceId")]
    public string InstanceId { get; init; } = string.Empty;

    [JsonPropertyName("revision")]
    public long Revision { get; init; }

    [JsonPropertyName("accounts")]
    public AccountDto[] Accounts { get; init; } = [];

    [JsonPropertyName("groups")]
    public GroupDto[] Groups { get; init; } = [];

    [JsonPropertyName("proxies")]
    public ProxyStateDto Proxies { get; init; } = new();

    [JsonPropertyName("conversations")]
    public Dictionary<string, ConversationSetDto> Conversations { get; init; } = [];

    [JsonPropertyName("scheduler")]
    public SchedulerStateDto Scheduler { get; init; } = new();

    /// <summary>最近的任务（含已结束）：重连或 Agent 重启后错误详情不该消失。</summary>
    [JsonPropertyName("operations")]
    public AgentOperationDto[] Operations { get; init; } = [];

    [JsonPropertyName("activeOperations")]
    public AgentOperationDto[] ActiveOperations { get; init; } = [];

    [JsonPropertyName("historyAccounts")]
    public HistoryAccountDto[] HistoryAccounts { get; init; } = [];

    [JsonPropertyName("settings")]
    public AgentSettingsDto Settings { get; init; } = new();

    [JsonPropertyName("draining")]
    public bool Draining { get; init; }
}

// record：单条事件（调度进度、窗口开关）只改动一两个字段时用 with 复制，
// 不必为增量更新另建一套可变模型。
internal sealed record AccountDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("note")]
    public string? Note { get; init; }

    [JsonPropertyName("email")]
    public string? Email { get; init; }

    [JsonPropertyName("gptName")]
    public string? GptName { get; init; }

    [JsonPropertyName("groupId")]
    public string? GroupId { get; init; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; init; }

    [JsonPropertyName("switchRule")]
    public string SwitchRule { get; init; } = "random";

    [JsonPropertyName("minWindows")]
    public int MinWindows { get; init; } = 1;

    [JsonPropertyName("maxWindows")]
    public int MaxWindows { get; init; } = 3;

    [JsonPropertyName("state")]
    public string? State { get; init; }

    [JsonPropertyName("loggedIn")]
    public bool LoggedIn { get; init; }

    [JsonPropertyName("statusDetail")]
    public string? StatusDetail { get; init; }

    [JsonPropertyName("checkedAt")]
    public DateTimeOffset? CheckedAt { get; init; }

    [JsonPropertyName("pageOpen")]
    public bool PageOpen { get; init; }

    [JsonPropertyName("stale")]
    public bool Stale { get; init; }

    [JsonPropertyName("rotationCurrentSet")]
    public string? RotationCurrentSet { get; init; }

    [JsonPropertyName("rotationWindowsDone")]
    public int RotationWindowsDone { get; init; }

    [JsonPropertyName("rotationWindowsTarget")]
    public int RotationWindowsTarget { get; init; }

    [JsonPropertyName("groupName")]
    public string? GroupName { get; init; }

    [JsonPropertyName("proxyId")]
    public string? ProxyId { get; init; }

    [JsonPropertyName("proxyName")]
    public string? ProxyName { get; init; }

    [JsonPropertyName("proxyMissing")]
    public bool ProxyMissing { get; init; }

    [JsonPropertyName("nextRunAt")]
    public DateTimeOffset? NextRunAt { get; init; }

    [JsonPropertyName("lastRunAt")]
    public DateTimeOffset? LastRunAt { get; init; }

    [JsonPropertyName("running")]
    public bool Running { get; init; }

    [JsonPropertyName("lastRunOk")]
    public bool? LastRunOk { get; init; }

    [JsonPropertyName("lastRunReason")]
    public string? LastRunReason { get; init; }

    [JsonIgnore]
    public string DisplayName => !string.IsNullOrWhiteSpace(Email)
        ? Email
        : !string.IsNullOrWhiteSpace(GptName)
            ? GptName
            : Id;

    [JsonIgnore]
    public string NoteText => string.IsNullOrWhiteSpace(Note) ? "未填写备注" : Note;

    [JsonIgnore]
    public string StatusText => PageOpen
        ? "Chrome 已打开"
        : LoggedIn
            ? "已登录"
            : State switch
            {
                "waf" => "遇到 WAF",
                "unknown" => "状态未知",
                "logged_out" => "未登录",
                "reauth" => "需重新登录",
                _ => StatusDetail ?? "等待检查",
            };

    /// <summary>状态徽章颜色。旧网页面板用颜色点区分四态，原生端不该退化成纯文字。</summary>
    [JsonIgnore]
    public IBrush StatusColor => PageOpen
        ? Palette.Info
        : LoggedIn
            ? Stale ? Palette.Warning : Palette.Ok
            : State switch
            {
                "reauth" => Palette.Warning,
                "waf" => Palette.Danger,
                "logged_out" => Palette.Danger,
                _ => Palette.Muted,
            };

    /// <summary>“· 待复核”：上次检查没能确认，但保留了此前的明确状态。</summary>
    [JsonIgnore]
    public string StaleText => Stale ? " · 待复核" : string.Empty;

    [JsonIgnore]
    public string CheckedAtText => RelativeTime.Describe(CheckedAt);

    [JsonIgnore]
    public string CheckedAtTooltip => CheckedAt is null
        ? "尚未检查过登录状态"
        : $"检查时间：{CheckedAt.Value.ToLocalTime():yyyy-MM-dd HH:mm:ss}"
            + (string.IsNullOrWhiteSpace(StatusDetail) ? string.Empty : $"\n详情：{StatusDetail}")
            + (string.IsNullOrWhiteSpace(LastCheckDetail) || LastCheckDetail == StatusDetail
                ? string.Empty
                : $"\n最近检查：{LastCheckDetail}")
            + (ConfirmedAt is null
                ? string.Empty
                : $"\n上次明确确认：{ConfirmedAt.Value.ToLocalTime():yyyy-MM-dd HH:mm:ss}");

    [JsonPropertyName("lastCheckState")]
    public string? LastCheckState { get; init; }

    [JsonPropertyName("lastCheckDetail")]
    public string? LastCheckDetail { get; init; }

    [JsonPropertyName("confirmedState")]
    public string? ConfirmedState { get; init; }

    [JsonPropertyName("confirmedAt")]
    public DateTimeOffset? ConfirmedAt { get; init; }

    /// <summary>出口标签。账号自己不持有代理，出口完全由所属分组决定。</summary>
    [JsonIgnore]
    public string RouteText => string.IsNullOrWhiteSpace(ProxyId)
        ? "出口：跟随系统"
        : ProxyMissing
            ? "出口：节点已失效"
            : $"出口：{ProxyName ?? ProxyId}";

    [JsonIgnore]
    public IBrush RouteColor => string.IsNullOrWhiteSpace(ProxyId)
        ? Palette.Muted
        : ProxyMissing
            ? Palette.Danger
            : Palette.Ok;

    /// <summary>轮换进度：当前会话集标识与已完成/目标窗口数。</summary>
    [JsonIgnore]
    public string RotationText => string.IsNullOrWhiteSpace(RotationCurrentSet)
        ? "未开始轮换"
        : $"{RotationCurrentSet} · {RotationWindowsDone}/{RotationWindowsTarget} 窗口";

    [JsonIgnore]
    public double RotationProgress => RotationWindowsTarget > 0
        ? Math.Clamp((double)RotationWindowsDone / RotationWindowsTarget, 0, 1)
        : 0;

    [JsonIgnore]
    public string ScheduleText => Running
        ? "正在运行"
        : NextRunAt is null
            ? Enabled ? "等待调度" : "已停用"
            : $"下次 {RelativeTime.DescribeFuture(NextRunAt)}";

    [JsonIgnore]
    public string LastRunText => LastRunAt is null
        ? "尚未运行"
        : LastRunOk == true
            ? $"上次成功 · {RelativeTime.Describe(LastRunAt)}"
            : LastRunOk == false
                ? $"上次失败 · {RelativeTime.Describe(LastRunAt)}"
                : $"上次 {RelativeTime.Describe(LastRunAt)}";

    [JsonIgnore]
    public bool IsLastRunFailed => LastRunOk == false;

    [JsonIgnore]
    public IBrush LastRunColor => LastRunOk switch
    {
        true => Palette.Ok,
        false => Palette.Danger,
        _ => Palette.Muted,
    };

    [JsonIgnore]
    public string LastRunTooltip => string.IsNullOrWhiteSpace(LastRunReason)
        ? LastRunText
        : $"{LastRunText}\n{LastRunReason}";
}

/// <summary>相对时间格式化。旧网页面板的“3 分钟前”比绝对时间戳更易扫读。</summary>
internal static class RelativeTime
{
    public static string Describe(DateTimeOffset? value)
    {
        if (value is null) return "未知时间";
        var span = DateTimeOffset.Now - value.Value;
        if (span < TimeSpan.Zero) return "刚刚";
        if (span < TimeSpan.FromMinutes(1)) return "刚刚";
        if (span < TimeSpan.FromHours(1)) return $"{(int)span.TotalMinutes} 分钟前";
        if (span < TimeSpan.FromDays(1)) return $"{(int)span.TotalHours} 小时前";
        if (span < TimeSpan.FromDays(30)) return $"{(int)span.TotalDays} 天前";
        return value.Value.ToLocalTime().ToString("yyyy-MM-dd");
    }

    public static string DescribeFuture(DateTimeOffset? value)
    {
        if (value is null) return "未安排";
        var span = value.Value - DateTimeOffset.Now;
        if (span <= TimeSpan.Zero) return "即将开始";
        if (span < TimeSpan.FromMinutes(1)) return "不到 1 分钟";
        if (span < TimeSpan.FromHours(1)) return $"约 {(int)span.TotalMinutes} 分钟后";
        if (span < TimeSpan.FromDays(1)) return $"约 {(int)span.TotalHours} 小时后";
        return value.Value.ToLocalTime().ToString("MM-dd HH:mm");
    }
}

internal sealed class SchedulerStateDto
{
    [JsonPropertyName("running")]
    public bool Running { get; init; }

    [JsonPropertyName("accounts")]
    public JsonElement Accounts { get; init; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; init; }
}

/// <summary>
/// 单账号调度变化。Agent 每次持久化 nextAt/lastAt 都会推一条，
/// 界面据此增量更新那一行，不需要为此做整表刷新。
/// </summary>
internal sealed class SchedulerAccountChangeDto
{
    [JsonPropertyName("accountId")]
    public string AccountId { get; init; } = string.Empty;

    [JsonPropertyName("nextAt")]
    public DateTimeOffset? NextAt { get; init; }

    [JsonPropertyName("lastAt")]
    public DateTimeOffset? LastAt { get; init; }

    [JsonPropertyName("busy")]
    public bool Busy { get; init; }

    [JsonPropertyName("lastResultState")]
    public string? LastResultState { get; init; }
}

/// <summary>
/// accountStatus.changed 的载荷。只带状态字段，不含出口和轮换信息，
/// 所以界面把它合并到已有的账号行上，而不是当成一个完整账号替换。
/// </summary>
internal sealed class AccountStatusEventDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("state")]
    public string? State { get; init; }

    [JsonPropertyName("loggedIn")]
    public bool LoggedIn { get; init; }

    [JsonPropertyName("email")]
    public string? Email { get; init; }

    [JsonPropertyName("detail")]
    public string? Detail { get; init; }

    [JsonPropertyName("checkedAt")]
    public DateTimeOffset? CheckedAt { get; init; }

    [JsonPropertyName("stale")]
    public bool Stale { get; init; }

    [JsonPropertyName("lastCheckState")]
    public string? LastCheckState { get; init; }

    [JsonPropertyName("lastCheckDetail")]
    public string? LastCheckDetail { get; init; }

    [JsonPropertyName("confirmedState")]
    public string? ConfirmedState { get; init; }

    [JsonPropertyName("confirmedAt")]
    public DateTimeOffset? ConfirmedAt { get; init; }
}

/// <summary>单节点测速结果。测完立刻回填到节点行，不必等整批任务结束。</summary>
internal sealed class ProxyNodeTestedDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("delay")]
    public int? Delay { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("testedAt")]
    public DateTimeOffset? TestedAt { get; init; }
}

internal sealed class HistoryAppendedDto
{
    [JsonPropertyName("accountId")]
    public string AccountId { get; init; } = string.Empty;

    [JsonPropertyName("entry")]
    public HistoryEntryDto Entry { get; init; } = new();
}

internal sealed class OpenPageChangeDto
{
    [JsonPropertyName("accountId")]
    public string AccountId { get; init; } = string.Empty;

    [JsonPropertyName("open")]
    public bool Open { get; init; }

    [JsonPropertyName("url")]
    public string? Url { get; init; }
}

internal sealed class GroupDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("proxyId")]
    public string? ProxyId { get; init; }

    [JsonPropertyName("timezone")]
    public string? Timezone { get; init; }

    [JsonPropertyName("locale")]
    public string? Locale { get; init; }

    /// <summary>出口节点名与账号数由 ViewModel 关联后填入，不参与序列化。</summary>
    [JsonIgnore]
    public string? ProxyName { get; set; }

    [JsonIgnore]
    public int AccountCount { get; set; }

    [JsonIgnore]
    public string RouteText => string.IsNullOrWhiteSpace(ProxyId)
        ? "系统网络"
        : ProxyName ?? ProxyId;

    [JsonIgnore]
    public string SummaryText => $"{AccountCount} 个账号 · {RouteText}";
}

internal sealed class ProxyStateDto
{
    [JsonPropertyName("nodes")]
    public ProxyNodeDto[] Nodes { get; init; } = [];

    [JsonPropertyName("subscription")]
    public ProxySubscriptionDto? Subscription { get; init; }

    [JsonPropertyName("status")]
    public JsonElement Status { get; init; }

    [JsonPropertyName("runtime")]
    public JsonElement Runtime { get; init; }
}

// record：测速事件只改延迟字段，用 with 复制即可增量回填到那一行。
internal sealed record ProxyNodeDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string? Type { get; init; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; init; }

    [JsonPropertyName("missing")]
    public bool Missing { get; init; }

    [JsonPropertyName("server")]
    public string? Server { get; init; }

    [JsonPropertyName("port")]
    public int? Port { get; init; }

    /// <summary>被分组引用的节点才有本地监听端口；测速走独立临时进程。</summary>
    [JsonPropertyName("localPort")]
    public int? LocalPort { get; init; }

    [JsonPropertyName("latencyMs")]
    public int? LatencyMs { get; init; }

    [JsonPropertyName("latencyOk")]
    public bool? LatencyOk { get; init; }

    [JsonPropertyName("latencyMessage")]
    public string? LatencyMessage { get; init; }

    [JsonPropertyName("latencyTestedAt")]
    public DateTimeOffset? LatencyTestedAt { get; init; }

    [JsonIgnore]
    public string StateText => Missing ? "订阅中已消失" : Enabled ? "已启用" : "已停用";

    [JsonIgnore]
    public IBrush StateColor => Missing ? Palette.Danger : Enabled ? Palette.Ok : Palette.Muted;

    [JsonIgnore]
    public string ServerText => string.IsNullOrWhiteSpace(Server)
        ? "地址未知"
        : Port is null ? Server : $"{Server}:{Port}";

    [JsonIgnore]
    public string LocalPortText => LocalPort is null ? "未被分组使用" : $"本地 {LocalPort}";

    /// <summary>延迟直接显示在节点行上，用户不必去任务中心翻 Operation 结果。</summary>
    [JsonIgnore]
    public string LatencyText => LatencyOk switch
    {
        true => LatencyMs is null ? "已连通" : $"{LatencyMs} ms",
        false => "测速失败",
        _ => "未测速",
    };

    [JsonIgnore]
    public IBrush LatencyColor => LatencyOk switch
    {
        true => LatencyMs is null or < 400 ? Palette.Ok : LatencyMs < 1000 ? Palette.Warning : Palette.Danger,
        false => Palette.Danger,
        _ => Palette.Faint,
    };

    [JsonIgnore]
    public string LatencyTooltip => LatencyOk switch
    {
        true => $"{LatencyMs} ms · {RelativeTime.Describe(LatencyTestedAt)}",
        false => $"{LatencyMessage ?? "测速失败"} · {RelativeTime.Describe(LatencyTestedAt)}",
        _ => "尚未测速",
    };
}

internal sealed class ProxySubscriptionDto
{
    [JsonPropertyName("host")]
    public string Host { get; init; } = string.Empty;

    [JsonPropertyName("updatedAt")]
    public DateTimeOffset? UpdatedAt { get; init; }
}

internal sealed class ConversationSetDto
{
    [JsonIgnore]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("topic")]
    public string Topic { get; init; } = string.Empty;

    [JsonPropertyName("minRounds")]
    public int MinRounds { get; init; }

    [JsonPropertyName("maxRounds")]
    public int MaxRounds { get; init; }

    [JsonIgnore]
    public string RoundsText => $"{MinRounds}–{MaxRounds} 轮";
}

/// <summary>
/// 一次运行的历史记录。Agent 已经把旧 JSONL 与 SQLite payload 统一成这个结构，
/// 界面不再自己去猜字段，也不会在猜不到时把原始 JSON 铺给用户看。
/// </summary>
internal sealed class HistoryEntryDto
{
    [JsonPropertyName("time")]
    public DateTimeOffset? Time { get; init; }

    [JsonPropertyName("ok")]
    public bool? Ok { get; init; }

    [JsonPropertyName("setName")]
    public string? SetName { get; init; }

    [JsonPropertyName("topic")]
    public string? Topic { get; init; }

    [JsonPropertyName("totalRounds")]
    public int TotalRounds { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("needReauth")]
    public bool NeedReauth { get; init; }

    [JsonPropertyName("rounds")]
    public HistoryRoundDto[] Rounds { get; init; } = [];

    [JsonIgnore]
    public string TimeText => Time is null
        ? "未知时间"
        : Time.Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");

    [JsonIgnore]
    public string ResultText => Ok switch
    {
        true => "成功",
        false => NeedReauth ? "需重新登录" : "失败",
        _ => "未确认",
    };

    [JsonIgnore]
    public IBrush ResultColor => Ok switch
    {
        true => Palette.Ok,
        false => Palette.Danger,
        _ => Palette.Warning,
    };

    [JsonIgnore]
    public string SummaryText => string.IsNullOrWhiteSpace(SetName)
        ? $"{TotalRounds} 轮"
        : $"{SetName} · {TotalRounds} 轮";

    [JsonIgnore]
    public string DetailText => Error ?? Topic ?? SummaryText;

    [JsonIgnore]
    public bool HasRounds => Rounds.Length > 0;

    [JsonIgnore]
    public bool HasError => !string.IsNullOrWhiteSpace(Error);
}

internal sealed class HistoryRoundDto
{
    [JsonPropertyName("question")]
    public string? Question { get; init; }

    [JsonPropertyName("answer")]
    public string? Answer { get; init; }

    [JsonPropertyName("at")]
    public string? At { get; init; }

    [JsonIgnore]
    public string QuestionText => string.IsNullOrWhiteSpace(Question) ? "（无提问内容）" : Question;

    [JsonIgnore]
    public string AnswerText => string.IsNullOrWhiteSpace(Answer) ? "（无回答内容）" : Answer;
}

internal sealed class HistoryAccountDto
{
    [JsonPropertyName("accountId")]
    public string AccountId { get; init; } = string.Empty;

    [JsonPropertyName("entryCount")]
    public int EntryCount { get; init; }

    [JsonPropertyName("lastAt")]
    public DateTimeOffset? LastAt { get; init; }

    [JsonPropertyName("lastOk")]
    public bool? LastOk { get; init; }

    [JsonPropertyName("deleted")]
    public bool Deleted { get; init; }

    [JsonPropertyName("note")]
    public string? Note { get; init; }

    [JsonPropertyName("email")]
    public string? Email { get; init; }

    [JsonPropertyName("gptName")]
    public string? GptName { get; init; }

    [JsonIgnore]
    public bool IsLastFailed => LastOk == false;

    [JsonIgnore]
    public string LastAtText => LastAt is null
        ? "时间未知"
        : RelativeTime.Describe(LastAt);

    [JsonIgnore]
    public string LastAtFullText => LastAt is null
        ? "历史记录未包含可用时间"
        : $"最后运行时间：{LastAt.Value.ToLocalTime():yyyy-MM-dd HH:mm:ss}";

    [JsonIgnore]
    public IBrush LastRunColor => LastOk switch
    {
        true => Palette.Ok,
        false => Palette.Danger,
        _ => Palette.Muted,
    };

    [JsonIgnore]
    public string DisplayName => Email ?? GptName ?? (!string.IsNullOrWhiteSpace(Note) ? Note : AccountId);

    [JsonIgnore]
    public string Summary => $"{EntryCount} 条{(Deleted ? " · 账号已删除" : string.Empty)}";
}

internal sealed class AgentSettingsDto
{
    [JsonPropertyName("intervalMinutes")]
    public double IntervalMinutes { get; init; } = 180;

    [JsonPropertyName("jitterMinutes")]
    public double JitterMinutes { get; init; } = 30;

    [JsonPropertyName("headless")]
    public bool Headless { get; init; } = true;

    [JsonPropertyName("statusCheckMinutes")]
    public double StatusCheckMinutes { get; init; } = 15;

    [JsonPropertyName("statusCheckOnStartup")]
    public bool StatusCheckOnStartup { get; init; } = true;

    [JsonPropertyName("openPageTimeoutMinutes")]
    public double OpenPageTimeoutMinutes { get; init; }

    [JsonPropertyName("profileAutoCleanEnabled")]
    public bool ProfileAutoCleanEnabled { get; init; } = true;
}

internal sealed class ProfileEntryDto : ObservableObject
{
    private string[] _accountLabels = [];

    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("linked")]
    public bool Linked { get; init; }

    [JsonPropertyName("accountIds")]
    public string[] AccountIds { get; init; } = [];

    [JsonPropertyName("accountLabels")]
    public string[] AccountLabels
    {
        get => _accountLabels;
        set
        {
            if (!SetProperty(ref _accountLabels, value ?? [])) return;
            OnPropertyChanged(nameof(DisplayName));
        }
    }

    [JsonPropertyName("busy")]
    public bool Busy { get; init; }

    [JsonPropertyName("bytes")]
    public long Bytes { get; init; }

    [JsonPropertyName("files")]
    public int Files { get; init; }

    [JsonPropertyName("cacheBytes")]
    public long CacheBytes { get; init; }

    [JsonIgnore]
    public string DisplayName => Linked
        ? AccountLabels.FirstOrDefault(label =>
                !string.IsNullOrWhiteSpace(label)
                && !AccountIds.Contains(label, StringComparer.Ordinal))
            ?? "未命名账号"
        : Name;

    [JsonIgnore]
    public string StateText => AccountIds.Length > 1
        ? $"异常：关联 {AccountIds.Length} 个账号"
        : Busy
            ? "正在使用"
            : Linked ? "已关联" : "孤儿 Profile";

    [JsonIgnore]
    public string SizeText => $"{FormatBytes(Bytes)} · 缓存 {FormatBytes(CacheBytes)}";

    private static string FormatBytes(long bytes)
    {
        var value = (double)Math.Max(0, bytes);
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var index = 0;
        while (value >= 1024 && index < units.Length - 1) { value /= 1024; index++; }
        return $"{value:0.##} {units[index]}";
    }
}

internal sealed class ProfileTotalsDto
{
    public int Profiles { get; init; }
    public int Linked { get; init; }
    public int Orphans { get; init; }
    public long Bytes { get; init; }
    public long CacheBytes { get; init; }
    public long OrphanBytes { get; init; }
    public int ArchiveCount { get; init; }
    public long ArchiveBytes { get; init; }
    public int TrashCount { get; init; }
    public long TrashBytes { get; init; }
}

internal sealed class ProfileScanResultDto
{
    public ProfileEntryDto[] Profiles { get; init; } = [];
    public ProfileEntryDto[] Orphans { get; init; } = [];
    public ProfileTotalsDto Totals { get; init; } = new();
}

internal sealed class AgentOperationDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("kind")]
    public string Kind { get; init; } = string.Empty;

    [JsonPropertyName("resourceId")]
    public string? ResourceId { get; init; }

    [JsonPropertyName("state")]
    public string State { get; init; } = string.Empty;

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("stage")]
    public string? Stage { get; init; }

    [JsonPropertyName("progress")]
    public double? Progress { get; init; }

    [JsonPropertyName("blocksUpdate")]
    public bool BlocksUpdate { get; init; }

    [JsonPropertyName("startedAt")]
    public DateTimeOffset? StartedAt { get; init; }

    [JsonPropertyName("updatedAt")]
    public DateTimeOffset? UpdatedAt { get; init; }

    [JsonPropertyName("finishedAt")]
    public DateTimeOffset? FinishedAt { get; init; }

    [JsonPropertyName("result")]
    public JsonElement Result { get; init; }

    [JsonPropertyName("error")]
    public AgentErrorDto? Error { get; init; }

    [JsonIgnore]
    public string StateText => State switch
    {
        "queued" => "排队中",
        "running" => "运行中",
        "waiting_user" => "等待用户",
        "succeeded" => "成功",
        "failed" => "失败",
        "timed_out" => "超时",
        "cancelled" => "已取消",
        _ => State,
    };

    [JsonIgnore]
    public string DetailText => Error is not null ? $"[{Error.Code}] {Error.Message}" : Message ?? Stage ?? Kind;

    [JsonIgnore]
    public IBrush StateColor => State switch
    {
        "succeeded" => Palette.Ok,
        "failed" or "timed_out" => Palette.Danger,
        "waiting_user" => Palette.Warning,
        "cancelled" => Palette.Muted,
        _ => Palette.Info,
    };

    [JsonIgnore]
    public bool IsTerminal => State is "succeeded" or "failed" or "timed_out" or "cancelled";

    /// <summary>任务类型的中文名。界面不该直接把内部 kind 字符串给用户看。</summary>
    [JsonIgnore]
    public string KindText => Kind switch
    {
        "account-status-refresh" => "刷新登录状态",
        "account-run" => "立即运行对话",
        "account-login" => "账号登录",
        "open-page-start" => "打开真实 Chrome",
        "proxy-import" => "导入代理订阅",
        "proxy-refresh" => "刷新代理订阅",
        "proxy-runtime-directory" => "设置代理运行目录",
        "proxy-node-toggle" => "切换节点启停",
        "proxy-node-test" => "节点测速",
        "proxy-test-all" => "全部节点测速",
        "profile-scan" => "扫描 Profile",
        "profile-cache-clean" => "清理 Profile 缓存",
        "profile-orphan-archive" => "归档孤儿 Profile",
        "profile-orphan-purge" => "永久删除孤儿 Profile",
        _ => Kind,
    };

    [JsonIgnore]
    public string TimeText => StartedAt is null
        ? string.Empty
        : StartedAt.Value.ToLocalTime().ToString("HH:mm:ss");

    [JsonIgnore]
    public bool HasProgress => Progress is > 0 and < 1;

    [JsonIgnore]
    public bool HasError => Error is not null;
}

internal sealed class AgentActivityResult
{
    [JsonPropertyName("draining")]
    public bool Draining { get; init; }

    [JsonPropertyName("blockers")]
    public ActivityBlockerDto[] Blockers { get; init; } = [];
}

internal sealed class ActivityBlockerDto
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = string.Empty;

    [JsonPropertyName("resourceId")]
    public string? ResourceId { get; init; }
}

internal sealed record AccountIdParams(
    [property: JsonPropertyName("accountId")] string AccountId);

internal sealed record AccountIdWithForceParams(
    [property: JsonPropertyName("accountId")] string AccountId,
    [property: JsonPropertyName("force")] bool Force);

internal sealed record AccountCreateParams(
    [property: JsonPropertyName("note")] string Note,
    // 创建时就能选分组：分组决定出口，登录必须走对应节点，事后再改会先用错网络登录一次。
    [property: JsonPropertyName("groupId")] string? GroupId = null,
    [property: JsonPropertyName("enabled")] bool Enabled = true,
    [property: JsonPropertyName("switchRule")] string SwitchRule = "random",
    [property: JsonPropertyName("minWindows")] int MinWindows = 1,
    [property: JsonPropertyName("maxWindows")] int MaxWindows = 3);

internal sealed record AccountUpdateParams(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("patch")] AccountPatchDto Patch);

internal sealed class AccountPatchDto
{
    [JsonPropertyName("note")]
    public string? Note { get; init; }

    [JsonPropertyName("groupId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? GroupId { get; init; }

    [JsonPropertyName("enabled")]
    public bool? Enabled { get; init; }

    [JsonPropertyName("switchRule")]
    public string? SwitchRule { get; init; }

    [JsonPropertyName("minWindows")]
    public int? MinWindows { get; init; }

    [JsonPropertyName("maxWindows")]
    public int? MaxWindows { get; init; }
}

internal sealed record AccountToggleParams(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("patch")] AccountEnabledPatchDto Patch);

internal sealed class AccountEnabledPatchDto
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; init; }
}

internal sealed record AccountRemoveParams(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("profileAction")] string ProfileAction);

internal sealed record GroupCreateParams(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("proxyId")] string? ProxyId,
    [property: JsonPropertyName("timezone")] string? Timezone = null,
    [property: JsonPropertyName("locale")] string? Locale = null);

internal sealed record GroupUpdateParams(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("patch")] GroupPatchDto Patch);

internal sealed class GroupPatchDto
{
    public string? Name { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ProxyId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Timezone { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Locale { get; init; }
}

internal sealed record IdParams([property: JsonPropertyName("id")] string Id);

internal sealed record ProxySubscriptionParams(
    [property: JsonPropertyName("url")] string Url);

internal sealed record ProxyNodeEnabledParams(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("enabled")] bool Enabled);

internal sealed record ProxyRuntimeDirectoryParams(
    [property: JsonPropertyName("directory")] string Directory);

internal sealed record ConversationUpsertParams(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("set")] ConversationSetDto Set);

internal sealed record NameParams([property: JsonPropertyName("name")] string Name);

internal sealed record HistoryQueryParams(
    [property: JsonPropertyName("accountId")] string AccountId,
    [property: JsonPropertyName("limit")] int Limit);

internal sealed record OperationListParams(
    [property: JsonPropertyName("limit")] int Limit,
    [property: JsonPropertyName("includeTerminal")] bool IncludeTerminal = true);

internal sealed record ProfileCleanParams(
    [property: JsonPropertyName("scope")] string Scope,
    [property: JsonPropertyName("name")] string? Name = null);

internal sealed record SettingsUpdateParams(
    [property: JsonPropertyName("patch")] AgentSettingsPatchDto Patch);

internal sealed class AgentSettingsPatchDto
{
    public double IntervalMinutes { get; init; }
    public double JitterMinutes { get; init; }
    public bool Headless { get; init; }
    public double StatusCheckMinutes { get; init; }
    public bool StatusCheckOnStartup { get; init; }
    public double OpenPageTimeoutMinutes { get; init; }
    public bool ProfileAutoCleanEnabled { get; init; }
}

internal sealed record ShutdownParams(
    [property: JsonPropertyName("reason")] string Reason,
    // 默认不强退：开着 Chrome 或有关键任务时 Agent 会拒绝，由界面列出阻塞项。
    [property: JsonPropertyName("force")] bool Force = false);

internal sealed record PrepareUpdateParams(
    [property: JsonPropertyName("commit")] bool Commit,
    [property: JsonPropertyName("reason")] string Reason);

internal sealed class PrepareUpdateResult
{
    [JsonPropertyName("ready")]
    public bool Ready { get; init; }

    [JsonPropertyName("committed")]
    public bool Committed { get; init; }

    [JsonPropertyName("blockers")]
    public ActivityBlockerDto[] Blockers { get; init; } = [];
}

internal sealed class AcceptedResult
{
    [JsonPropertyName("accepted")]
    public bool Accepted { get; init; }
}

internal sealed class OkResult
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }
}
