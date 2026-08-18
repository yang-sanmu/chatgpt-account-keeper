namespace GptAccountKeeper.Desktop.Tests;

/// <summary>
/// 定位打包用图标资产的公共代码。
///
/// 这些资产是**按平台**分的，不是通用契约：Windows 要 .ico（PE 图标资源 +
/// vpk pack --icon），macOS 要 .icns（CFBundleIconFile），Linux 要一组
/// XDG hicolor PNG。三者都由 scripts/generate-app-icon.mjs 从同一份矢量图形生成，
/// 所以 M6 加 macOS/Linux 资产时，在这里加一个属性、再配一个
/// &lt;Platform&gt;AppIconFileTests 就够，不要把 .ico 的断言改成全平台通用。
///
/// 注意：这里查的是**仓库里的源文件**，不是构建产物，所以测试本身与运行平台无关 ——
/// 在 Linux CI 上跑 Windows 的图标断言是合理的，能在打包前就发现资产缺失。
/// </summary>
internal static class PackagingIconAssets
{
    private static readonly string[] ProjectSegments =
        ["desktop", "src", "GptAccountKeeper.Desktop"];

    /// <summary>Windows：exe 图标资源和安装器/快捷方式图标。</summary>
    public static string WindowsIcon => Resolve("app-icon.ico");

    /// <summary>macOS bundle、Dock 与安装器使用的多分辨率 ICNS。</summary>
    public static string MacOsIcon => Resolve("app-icon.icns");

    public static string InfoPlist => Resolve("Info.plist");

    public static string LinuxIcon(int size) => Resolve(
        Path.Combine("icons", "hicolor", $"{size}x{size}", "apps", "gpt-account-keeper.png"));

    /// <summary>窗口图标用的 256px 母版（各平台共用的矢量渲染结果）。</summary>
    public static string MasterPng => Resolve("app-icon.png");

    public static string DesktopProject => Resolve("GptAccountKeeper.Desktop.csproj");

    private static string Resolve(string fileName)
    {
        // 测试程序集跑在 tests/<project>/bin/<cfg>/<tfm>，逐级上溯找仓库根，
        // 不写死层数（分隔符交给 Path.Combine，Windows/Linux/macOS 都对）。
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                [directory.FullName, .. ProjectSegments, fileName]);
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }

        throw new InvalidOperationException(
            $"{fileName} was not found. Run: node scripts/generate-app-icon.mjs");
    }
}
