using System.Diagnostics;
using System.Security.Cryptography;

namespace GptAccountKeeper.Desktop.Infrastructure.Ipc;

internal sealed class IpcCredentialStore
{
    public string LoadOrCreate(string keyFile)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(keyFile)!);
        if (File.Exists(keyFile))
        {
            var existing = File.ReadAllText(keyFile).Trim();
            if (Convert.TryFromBase64String(existing, new byte[64], out var bytesWritten)
                && bytesWritten == 32)
            {
                RestrictPermissions(keyFile);
                return existing;
            }
        }

        var credential = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var temporary = $"{keyFile}.{Environment.ProcessId}.tmp";
        try
        {
            File.WriteAllText(temporary, credential);
            RestrictPermissions(temporary);
            File.Move(temporary, keyFile, overwrite: true);
            RestrictPermissions(keyFile);
        }
        finally
        {
            File.Delete(temporary);
        }

        return credential;
    }

    private static void RestrictPermissions(string keyFile)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(keyFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            return;
        }

        var identity = $"{Environment.UserDomainName}\\{Environment.UserName}";
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = "icacls.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList =
            {
                keyFile,
                "/inheritance:r",
                "/grant:r",
                $"{identity}:(F)",
            },
        }) ?? throw new InvalidOperationException("无法设置 IPC 凭据文件权限");
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new IOException($"无法限制 IPC 凭据文件权限：{process.StandardError.ReadToEnd().Trim()}");
        }
    }
}
