using System.Collections.ObjectModel;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 按 key 增量同步 ObservableCollection。
///
/// 早先每次事件都做 Clear() + 逐个 Add()，后果是连锁的：ListBox 的 SelectedItem
/// 在 Clear 时被置空，选中项的 setter 又会用服务端数据覆盖右侧正在编辑的草稿，
/// 同时滚动位置回到顶部、列表整体闪烁。状态巡检每 15 分钟推一次事件，用户改备注
/// 时正好撞上就会丢输入。
///
/// 这里只增删移动真正变化的项：未变化的项保持同一个实例引用，选中和滚动都不动。
/// </summary>
internal static class CollectionSync
{
    /// <summary>
    /// 用 <paramref name="incoming"/> 的顺序和内容同步 <paramref name="target"/>。
    /// </summary>
    /// <param name="keyOf">稳定标识（账号 id、节点 id、分组 id 等）。</param>
    /// <param name="areEqual">
    /// 判断同 key 的两个项是否等价。等价时保留原实例，避免 UI 重建那一行。
    /// </param>
    public static void Apply<T>(
        ObservableCollection<T> target,
        IReadOnlyList<T> incoming,
        Func<T, string> keyOf,
        Func<T, T, bool>? areEqual = null)
        where T : class
    {
        var existing = new Dictionary<string, T>(target.Count, StringComparer.Ordinal);
        foreach (var item in target)
        {
            // 重复 key 不该出现；真出现时后者胜出，至少不抛异常打断界面。
            existing[keyOf(item)] = item;
        }

        var wantedKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in incoming) wantedKeys.Add(keyOf(item));

        for (var index = target.Count - 1; index >= 0; index--)
        {
            if (!wantedKeys.Contains(keyOf(target[index]))) target.RemoveAt(index);
        }

        for (var index = 0; index < incoming.Count; index++)
        {
            var wanted = incoming[index];
            var key = keyOf(wanted);
            if (existing.TryGetValue(key, out var current))
            {
                var currentIndex = target.IndexOf(current);
                if (currentIndex < 0)
                {
                    target.Insert(Math.Min(index, target.Count), wanted);
                    continue;
                }

                // 内容没变就不动实例：这是保住选中项和滚动位置的关键。
                if (areEqual is null || !areEqual(current, wanted))
                {
                    target[currentIndex] = wanted;
                }
                if (currentIndex != index && index < target.Count)
                {
                    target.Move(currentIndex, index);
                }
            }
            else
            {
                target.Insert(Math.Min(index, target.Count), wanted);
            }
        }

        // 目标可能仍多出重复项（重复 key 的情况），按长度收尾。
        while (target.Count > incoming.Count) target.RemoveAt(target.Count - 1);
    }

    /// <summary>就地替换单个项，其余项一律不动。用于单条事件的增量应用。</summary>
    public static bool Replace<T>(
        ObservableCollection<T> target,
        T item,
        Func<T, string> keyOf)
        where T : class
    {
        var key = keyOf(item);
        for (var index = 0; index < target.Count; index++)
        {
            if (!string.Equals(keyOf(target[index]), key, StringComparison.Ordinal)) continue;
            target[index] = item;
            return true;
        }
        return false;
    }

    public static bool RemoveByKey<T>(
        ObservableCollection<T> target,
        string key,
        Func<T, string> keyOf)
        where T : class
    {
        for (var index = 0; index < target.Count; index++)
        {
            if (!string.Equals(keyOf(target[index]), key, StringComparison.Ordinal)) continue;
            target.RemoveAt(index);
            return true;
        }
        return false;
    }
}
