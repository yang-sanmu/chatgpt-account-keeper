using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

/// <summary>
/// **Windows 专属**打包资产断言：app-icon.ico 是"装完有没有图标"的关键 ——
/// csproj 用它做 exe 的 Win32 图标资源，vpk pack --icon 用它做安装器、卸载项和
/// 桌面/开始菜单快捷方式的图标。文件丢了或尺寸缺了，表现就是装完没图标，
/// 而 CLI 布局下跑测试看不出来，所以在这里守住。
///
/// 这里的尺寸表和 ICO 二进制格式都只对 Windows 成立。macOS/Linux 的图标资产
/// （.icns、XDG hicolor PNG）属于 M6，到时候各配一个测试类，
/// 不要把这里的断言当成全平台契约 —— 见 <see cref="PackagingIconAssets"/>。
/// </summary>
public sealed class WindowsAppIconFileTests
{
    // Windows 会挑最接近的一档再缩放。这些是 shell 实际会请求的尺寸：
    // 任务栏、资源管理器各视图、Alt+Tab 切换器，以及高 DPI 缩放。
    private static readonly int[] RequiredSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

    [Fact]
    public void IconFileCoversEveryShellSize()
    {
        var bytes = File.ReadAllBytes(PackagingIconAssets.WindowsIcon);

        Assert.Equal(0, BitConverter.ToUInt16(bytes, 0)); // reserved
        Assert.Equal(1, BitConverter.ToUInt16(bytes, 2)); // type: icon
        var count = BitConverter.ToUInt16(bytes, 4);

        var sizes = new List<int>();
        for (var i = 0; i < count; i++)
        {
            var entry = 6 + (i * 16);
            // A width byte of 0 encodes 256, which does not fit in a byte.
            sizes.Add(bytes[entry] == 0 ? 256 : bytes[entry]);

            var length = BitConverter.ToInt32(bytes, entry + 8);
            var offset = BitConverter.ToInt32(bytes, entry + 12);
            Assert.True(
                offset > 0 && length > 0 && offset + length <= bytes.Length,
                $"Icon entry {i} points outside the file");
            Assert.Equal(32, BitConverter.ToUInt16(bytes, entry + 6)); // bits per pixel
        }

        Assert.Equal<IEnumerable<int>>(RequiredSizes, sizes.Order().ToArray());
    }

    [Fact]
    public void SmallIconEntriesAreTransparentInTheirCorners()
    {
        var bytes = File.ReadAllBytes(PackagingIconAssets.WindowsIcon);
        var count = BitConverter.ToUInt16(bytes, 4);
        var checkedAny = false;

        for (var i = 0; i < count; i++)
        {
            var entry = 6 + (i * 16);
            var size = bytes[entry] == 0 ? 256 : bytes[entry];
            var offset = BitConverter.ToInt32(bytes, entry + 12);

            // Only the BMP-encoded entries are read here; 128/256 are stored as
            // PNG and are already covered by the embedded-raster tests.
            var headerSize = BitConverter.ToInt32(bytes, offset);
            if (headerSize != 40) continue;
            checkedAny = true;

            // 32-bit BMP payload: BGRA, bottom-up, no row padding at 4 bytes/px.
            var pixels = offset + 40;
            foreach (var (x, y) in new[] { (0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1) })
            {
                var alpha = bytes[pixels + ((((size - 1 - y) * size) + x) * 4) + 3];
                Assert.True(
                    alpha == 0,
                    $"{size}px icon corner ({x},{y}) has alpha {alpha}; an opaque corner is " +
                    "what draws a black box around the taskbar icon");
            }
        }

        Assert.True(checkedAny, "No BMP-encoded icon entries were found to check");
    }

    [Fact]
    public void ProjectReferencesTheIconAsItsApplicationIcon()
    {
        // Guards the actual "no icon after install" cause: the file can exist and
        // still not be compiled into the exe as a Win32 resource.
        //
        // ApplicationIcon 是 Windows PE 资源的概念，SDK 在非 Windows RID 下会
        // 静默忽略它（linux-x64/osx-arm64 构建实测零警告通过），所以这里不需要
        // 给它加 Condition，也不影响将来的 macOS/Linux 构建。
        Assert.Contains(
            "<ApplicationIcon>app-icon.ico</ApplicationIcon>",
            File.ReadAllText(PackagingIconAssets.DesktopProject));
    }
}
