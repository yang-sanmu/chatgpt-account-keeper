using System.Text.Json;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Infrastructure.Settings;

internal sealed class DesktopSettingsStore
{
    private readonly AppPaths _paths;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public DesktopSettingsStore(AppPaths paths)
    {
        _paths = paths;
    }

    public async Task<DesktopSettings> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(_paths.SettingsFile))
            {
                return new DesktopSettings();
            }

            await using var stream = new FileStream(
                _paths.SettingsFile,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            return await JsonSerializer.DeserializeAsync(
                    stream,
                    AppJsonContext.Default.DesktopSettings,
                    cancellationToken)
                .ConfigureAwait(false)
                ?? new DesktopSettings();
        }
        catch (JsonException)
        {
            return new DesktopSettings();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveAsync(DesktopSettings settings, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(_paths.ConfigurationDirectory);
            var temporaryFile = $"{_paths.SettingsFile}.{Environment.ProcessId}.tmp";
            try
            {
                await using (var stream = new FileStream(
                    temporaryFile,
                    FileMode.Create,
                    FileAccess.Write,
                    FileShare.None,
                    bufferSize: 4096,
                    FileOptions.Asynchronous | FileOptions.WriteThrough))
                {
                    await JsonSerializer.SerializeAsync(
                            stream,
                            settings,
                            AppJsonContext.Default.DesktopSettings,
                            cancellationToken)
                        .ConfigureAwait(false);
                    await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                }

                File.Move(temporaryFile, _paths.SettingsFile, overwrite: true);
            }
            finally
            {
                if (File.Exists(temporaryFile))
                {
                    File.Delete(temporaryFile);
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }
}
