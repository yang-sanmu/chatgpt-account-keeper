using System.Text.Json;

namespace GptAccountKeeper.Desktop.Infrastructure.Settings;

internal sealed class DataLocationService
{
    private readonly AppPaths _paths;

    public DataLocationService(AppPaths paths)
    {
        _paths = paths;
    }

    public string Validate(string selectedDirectory)
    {
        if (!Path.IsPathFullyQualified(selectedDirectory))
        {
            throw new InvalidDataException("数据目录必须是绝对路径");
        }
        var target = Path.GetFullPath(selectedDirectory);
        if (Path.GetPathRoot(target)?.Equals(target, StringComparison.OrdinalIgnoreCase) == true)
        {
            throw new InvalidDataException("不能把文件系统根目录作为应用数据目录");
        }
        if (OperatingSystem.IsWindows())
        {
            if (target.StartsWith(@"\\", StringComparison.Ordinal))
            {
                throw new InvalidDataException("不能把数据库和 Profile 放在网络共享");
            }
            var drive = new DriveInfo(Path.GetPathRoot(target)!);
            if (drive.DriveType != DriveType.Fixed)
            {
                throw new InvalidDataException("数据目录必须位于本地固定磁盘");
            }
        }
        var install = Path.GetFullPath(AppContext.BaseDirectory);
        if (ContainsPath(target, install) || ContainsPath(install, target))
        {
            throw new InvalidDataException("数据目录不能与安装/程序目录重叠");
        }
        return target;
    }

    public async Task SaveAsync(string selectedDirectory, CancellationToken cancellationToken = default)
    {
        var target = Validate(selectedDirectory);
        Directory.CreateDirectory(_paths.ConfigurationDirectory);
        var temporary = $"{_paths.BootstrapFile}.{Environment.ProcessId}.tmp";
        try
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(
                new BootstrapPointer(1, target),
                Serialization.AppJsonContext.Default.BootstrapPointer);
            await File.WriteAllBytesAsync(temporary, payload, cancellationToken).ConfigureAwait(false);
            File.Move(temporary, _paths.BootstrapFile, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static bool ContainsPath(string candidate, string parent)
    {
        var relative = Path.GetRelativePath(parent, candidate);
        return relative == "." || (!relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathFullyQualified(relative));
    }
}

internal sealed record BootstrapPointer(int Version, string DataRoot);
