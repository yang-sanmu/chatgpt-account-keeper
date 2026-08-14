namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 一个"可编辑草稿"字段：区分"服务端数据"和"用户正在编辑的值"。
///
/// 早先备注、窗口数、分组等草稿直接是普通属性，任何一次数据刷新（状态巡检事件
/// 每 15 分钟就会来一次）都会经由 SelectedAccount setter 覆盖掉它们，用户输入
/// 一半就消失。这里的规则是：
///
/// - <see cref="Reset"/>：切换选中对象时无条件重置，草稿变干净。
/// - <see cref="Refresh"/>：数据刷新时调用；草稿是脏的就保留用户输入，
///   只更新"服务端当前值"用于后续比较。
/// - <see cref="Value"/> 被赋值即视为脏，直到保存或重置。
/// </summary>
/// <typeparam name="T">字段类型。</typeparam>
internal sealed class EditableField<T>
{
    private readonly IEqualityComparer<T> _comparer;
    private T _value;
    private T _serverValue;

    public EditableField(T initial, IEqualityComparer<T>? comparer = null)
    {
        _comparer = comparer ?? EqualityComparer<T>.Default;
        _value = initial;
        _serverValue = initial;
    }

    /// <summary>用户可见、可编辑的当前值。</summary>
    public T Value
    {
        get => _value;
        set
        {
            if (_comparer.Equals(_value, value)) return;
            _value = value;
            IsDirty = !_comparer.Equals(_value, _serverValue);
        }
    }

    /// <summary>服务端最近一次返回的值。</summary>
    public T ServerValue => _serverValue;

    /// <summary>用户改过且尚未保存。</summary>
    public bool IsDirty { get; private set; }

    /// <summary>切换到另一个对象：草稿无条件跟随新对象。</summary>
    public void Reset(T value)
    {
        _serverValue = value;
        _value = value;
        IsDirty = false;
    }

    /// <summary>
    /// 同一对象的数据刷新。返回 true 表示可见值发生了变化，需要通知 UI。
    /// 草稿是脏的就保留用户输入 —— 这正是"改备注时被巡检事件冲掉"的修复点。
    /// </summary>
    public bool Refresh(T value)
    {
        _serverValue = value;
        if (IsDirty) return false;
        if (_comparer.Equals(_value, value)) return false;
        _value = value;
        return true;
    }

    /// <summary>保存成功：以提交值为新基线。</summary>
    public void Commit(T value)
    {
        _serverValue = value;
        _value = value;
        IsDirty = false;
    }

    /// <summary>
    /// 接受一次异步提交的结果。若用户在请求期间又改了值，只更新服务端基线并保留新草稿；
    /// 只有当前值仍等于当时提交的值，才把服务端规范化后的结果显示出来并标记为干净。
    /// </summary>
    public bool CommitSubmitted(T submittedValue, T serverValue)
    {
        _serverValue = serverValue;
        if (!_comparer.Equals(_value, submittedValue))
        {
            IsDirty = !_comparer.Equals(_value, _serverValue);
            return false;
        }

        var changed = !_comparer.Equals(_value, serverValue);
        _value = serverValue;
        IsDirty = false;
        return changed;
    }

    /// <summary>放弃编辑，回到服务端值。返回 true 表示可见值发生了变化。</summary>
    public bool Revert()
    {
        if (!IsDirty) return false;
        _value = _serverValue;
        IsDirty = false;
        return true;
    }
}
