using System.Text;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

public sealed class MacOsAppIconFileTests
{
    private static readonly string[] RequiredTypes =
        ["icp4", "icp5", "icp6", "ic07", "ic08", "ic09", "ic10"];

    [Fact]
    public void IcnsContainsEveryRequiredPngSize()
    {
        var bytes = File.ReadAllBytes(PackagingIconAssets.MacOsIcon);
        Assert.Equal("icns", Encoding.ASCII.GetString(bytes, 0, 4));
        Assert.Equal(bytes.Length, ReadBigEndianInt32(bytes, 4));

        var types = new List<string>();
        var offset = 8;
        while (offset < bytes.Length)
        {
            var type = Encoding.ASCII.GetString(bytes, offset, 4);
            var length = ReadBigEndianInt32(bytes, offset + 4);
            Assert.True(length > 8 && offset + length <= bytes.Length, $"Invalid ICNS chunk {type}");
            Assert.Equal(
                new byte[] { 0x89, 0x50, 0x4e, 0x47 },
                bytes.AsSpan(offset + 8, 4).ToArray());
            types.Add(type);
            offset += length;
        }

        Assert.Equal(bytes.Length, offset);
        Assert.Equal<IEnumerable<string>>(RequiredTypes, types);
    }

    [Fact]
    public void InfoPlistReferencesTheCommittedIconAndVersionPlaceholders()
    {
        var plist = File.ReadAllText(PackagingIconAssets.InfoPlist);
        Assert.Contains("<string>app-icon.icns</string>", plist);
        Assert.Contains("<string>0.0.0-template</string>", plist);
        Assert.Contains("<string>0.0.0-build-template</string>", plist);
    }

    private static int ReadBigEndianInt32(byte[] bytes, int offset) =>
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
}
