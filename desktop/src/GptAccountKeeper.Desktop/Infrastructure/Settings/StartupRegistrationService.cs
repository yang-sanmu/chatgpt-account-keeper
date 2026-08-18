using System.Diagnostics;
using System.Security;
using Microsoft.Win32;

namespace GptAccountKeeper.Desktop.Infrastructure.Settings;

internal sealed class StartupRegistrationService
{
    private const string WindowsRunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RegistrationName = "GptAccountKeeper.Desktop";

    public void SetEnabled(bool enabled)
    {
        // Disabling a registration must not depend on resolving the current
        // executable. In particular, first launch defaults to disabled and may
        // run before any platform-specific registration directory exists.
        var executable = enabled
            ? ResolveExecutableForStartup(
                Environment.ProcessPath,
                Environment.GetEnvironmentVariable("APPIMAGE"),
                OperatingSystem.IsLinux())
            : null;

        if (OperatingSystem.IsWindows())
        {
            using var key = Registry.CurrentUser.CreateSubKey(WindowsRunKey, writable: true)
                ?? throw new InvalidOperationException("无法打开当前用户的开机启动注册表项");
            if (enabled)
            {
                key.SetValue(RegistrationName, $"\"{executable!}\" --hidden", RegistryValueKind.String);
            }
            else
            {
                key.DeleteValue(RegistrationName, throwOnMissingValue: false);
            }

            return;
        }

        if (OperatingSystem.IsMacOS())
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library",
                "LaunchAgents");
            var target = Path.Combine(directory, "io.github.yang-sanmu.gptaccountkeeper.plist");
            if (!enabled)
            {
                DeleteIfPresent(target);
                return;
            }

            Directory.CreateDirectory(directory);
            var escaped = SecurityElement.Escape(executable!) ?? executable;
            WriteAtomically(target, $"""
                <?xml version="1.0" encoding="UTF-8"?>
                <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
                <plist version="1.0"><dict>
                  <key>Label</key><string>io.github.yang-sanmu.gptaccountkeeper</string>
                  <key>ProgramArguments</key><array><string>{escaped}</string><string>--hidden</string></array>
                  <key>RunAtLoad</key><true/>
                </dict></plist>
                """);
            return;
        }

        var configRoot = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrWhiteSpace(configRoot))
        {
            configRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".config");
        }

        var autostartDirectory = Path.Combine(configRoot, "autostart");
        var desktopFile = Path.Combine(autostartDirectory, "gpt-account-keeper.desktop");
        if (!enabled)
        {
            DeleteIfPresent(desktopFile);
            return;
        }

        Directory.CreateDirectory(autostartDirectory);
        var escapedExecutable = EscapeDesktopExecArgument(executable!);
        WriteAtomically(desktopFile, $"""
            [Desktop Entry]
            Type=Application
            Name=ChatGPT Account Keeper
            Exec="{escapedExecutable}" --hidden
            Terminal=false
            X-GNOME-Autostart-enabled=true
            """);
    }

    internal static string ResolveExecutableForStartup(
        string? processPath,
        string? appImagePath,
        bool isLinux)
    {
        // AppImage runs the real executable from a transient /tmp/.mount_*
        // directory. APPIMAGE is the stable path selected by the user and is
        // the only path that remains valid for the next desktop session.
        if (isLinux && !string.IsNullOrWhiteSpace(appImagePath))
        {
            if (!Path.IsPathFullyQualified(appImagePath))
            {
                throw new InvalidOperationException("APPIMAGE must be an absolute path");
            }

            return Path.GetFullPath(appImagePath);
        }

        return processPath
            ?? throw new InvalidOperationException("无法确定桌面程序路径");
    }

    internal static string EscapeDesktopExecArgument(string value) => value
        .Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace("\"", "\\\"", StringComparison.Ordinal)
        .Replace("`", "\\`", StringComparison.Ordinal)
        .Replace("$", "\\$", StringComparison.Ordinal)
        .Replace("%", "%%", StringComparison.Ordinal);

    internal static void DeleteIfPresent(string target)
    {
        try
        {
            // File.Delete is idempotent for a missing file, but on Unix it can
            // still throw when a parent directory does not exist. That is the
            // normal first-launch state for ~/.config/autostart and, on a clean
            // macOS account, ~/Library/LaunchAgents.
            File.Delete(target);
        }
        catch (DirectoryNotFoundException)
        {
        }
    }

    private static void WriteAtomically(string target, string content)
    {
        var temporary = $"{target}.{Environment.ProcessId}.tmp";
        try
        {
            File.WriteAllText(temporary, content);
            File.Move(temporary, target, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }
}
