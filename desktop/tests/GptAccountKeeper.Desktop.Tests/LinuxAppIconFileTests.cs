using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

public sealed class LinuxAppIconFileTests
{
    private static readonly int[] RequiredSizes = [16, 24, 32, 48, 64, 128, 256, 512];

    [Fact]
    public void HicolorSetContainsAValidPngAtEveryRequiredSize()
    {
        foreach (var size in RequiredSizes)
        {
            var bytes = File.ReadAllBytes(PackagingIconAssets.LinuxIcon(size));
            Assert.Equal(
                new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a },
                bytes.AsSpan(0, 8).ToArray());
            Assert.Equal("IHDR", System.Text.Encoding.ASCII.GetString(bytes, 12, 4));
            Assert.Equal(size, ReadBigEndianInt32(bytes, 16));
            Assert.Equal(size, ReadBigEndianInt32(bytes, 20));
            Assert.Equal(6, bytes[25]); // RGBA, required for transparent corners.
        }
    }

    private static int ReadBigEndianInt32(byte[] bytes, int offset) =>
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
}
