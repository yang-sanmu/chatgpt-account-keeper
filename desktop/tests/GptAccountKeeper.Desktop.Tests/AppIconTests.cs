using GptAccountKeeper.Desktop.Application;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

/// <summary>
/// 内嵌栅格图（窗口 + 托盘）的回归测试。这两份 PNG 走 Avalonia/Skia 解码，
/// 三个平台**共用**，所以这里的断言是通用契约。
///
/// 主要守"图标外面一圈黑框"那个 bug：图形不透明地铺满整个画布、边角没留空。
/// Windows 表现为任务栏黑框，macOS Dock 和 Linux 各家托盘同样会把不透明边角
/// 照画出来，所以四角必须透明这条对三个平台都成立。
///
/// Windows 打包资产（app-icon.ico）另见 <see cref="WindowsAppIconFileTests"/>。
/// </summary>
public sealed class AppIconTests
{
    private static readonly byte[] PngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

    public static TheoryData<string, byte[]> EmbeddedIcons() => new()
    {
        { "window", AppIcon.GetWindowPngBytes() },
        { "tray", AppIcon.GetTrayPngBytes() },
    };

    [Theory]
    [MemberData(nameof(EmbeddedIcons))]
    public void EmbeddedIconIsAValidPngResource(string name, byte[] bytes)
    {
        Assert.True(bytes.Length > 64, $"{name} icon is too small to be a real PNG");
        Assert.Equal(PngSignature, bytes[..8]);

        var (width, height, bitDepth, colorType) = ReadIhdr(bytes);
        Assert.Equal(width, height);
        Assert.Equal(8, bitDepth);
        // Colour type 6 is truecolour + alpha. Anything else cannot carry the
        // transparent margin every platform's shell needs.
        Assert.Equal(6, colorType);
    }

    [Theory]
    [MemberData(nameof(EmbeddedIcons))]
    public void EmbeddedIconLeavesItsCornersTransparent(string name, byte[] bytes)
    {
        var (pixels, size) = Decode(bytes);

        foreach (var (x, y) in new[] { (0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1) })
        {
            var alpha = pixels[((y * size) + x) * 4 + 3];
            Assert.True(
                alpha == 0,
                $"{name} icon corner ({x},{y}) has alpha {alpha}; a non-transparent corner " +
                "renders as a dark box around the icon (Windows taskbar, macOS Dock, Linux tray)");
        }
    }

    [Theory]
    [MemberData(nameof(EmbeddedIcons))]
    public void EmbeddedIconIsOpaqueAtItsCentre(string name, byte[] bytes)
    {
        var (pixels, size) = Decode(bytes);
        var centre = ((size / 2 * size) + (size / 2)) * 4;

        Assert.Equal(255, pixels[centre + 3]);
        // Guards against a regression to the previous near-black artwork, which
        // was invisible against any dark shell background.
        var luminance =
            (0.2126 * pixels[centre]) + (0.7152 * pixels[centre + 1]) + (0.0722 * pixels[centre + 2]);
        Assert.True(luminance > 32, $"{name} icon centre is too dark (luminance {luminance:F1})");
    }

    [Fact]
    public void WindowAndTrayIconsUseDifferentRasters()
    {
        // 托盘那张是简化图形：Windows 画在 16-24px，Linux 各家桌面环境托盘尺寸
        // 也在 16/22/24 之间浮动，都需要一张抗缩放的图形。两者变成同一份字节，
        // 说明这个区分被弄丢了。
        Assert.NotEqual(AppIcon.GetWindowPngBytes(), AppIcon.GetTrayPngBytes());
    }

    private static (int Width, int Height, int BitDepth, int ColorType) ReadIhdr(byte[] png)
    {
        // IHDR is required to be the first chunk: 8-byte signature, then a
        // 4-byte length and the "IHDR" tag before the 13-byte payload.
        Assert.Equal("IHDR", System.Text.Encoding.ASCII.GetString(png, 12, 4));
        return (
            System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16, 4)),
            System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20, 4)),
            png[24],
            png[25]);
    }

    /// <summary>
    /// Minimal PNG decoder for the exact shape the generator emits: 8-bit RGBA,
    /// no interlacing. Deliberately not using an imaging library so the test has
    /// no dependency the desktop project does not already carry.
    /// </summary>
    private static (byte[] Pixels, int Size) Decode(byte[] png)
    {
        var (width, height, _, _) = ReadIhdr(png);

        using var compressed = new MemoryStream();
        var offset = 8;
        while (offset + 8 <= png.Length)
        {
            var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(
                png.AsSpan(offset, 4));
            var type = System.Text.Encoding.ASCII.GetString(png, offset + 4, 4);
            if (type == "IDAT")
            {
                compressed.Write(png, offset + 8, length);
            }

            offset += 12 + length; // length + type + data + CRC
        }

        compressed.Position = 0;
        using var inflate = new System.IO.Compression.ZLibStream(
            compressed,
            System.IO.Compression.CompressionMode.Decompress);
        using var raw = new MemoryStream();
        inflate.CopyTo(raw);
        var scanlines = raw.ToArray();

        const int bpp = 4;
        var stride = width * bpp;
        var pixels = new byte[stride * height];
        for (var y = 0; y < height; y++)
        {
            var filter = scanlines[y * (stride + 1)];
            var source = (y * (stride + 1)) + 1;
            for (var x = 0; x < stride; x++)
            {
                var left = x >= bpp ? pixels[(y * stride) + x - bpp] : 0;
                var up = y > 0 ? pixels[((y - 1) * stride) + x] : 0;
                var upLeft = x >= bpp && y > 0 ? pixels[((y - 1) * stride) + x - bpp] : 0;
                var value = scanlines[source + x];
                pixels[(y * stride) + x] = filter switch
                {
                    0 => value,
                    1 => (byte)(value + left),
                    2 => (byte)(value + up),
                    3 => (byte)(value + ((left + up) / 2)),
                    4 => (byte)(value + Paeth((byte)left, (byte)up, (byte)upLeft)),
                    _ => throw new InvalidOperationException($"Unsupported PNG filter {filter}"),
                };
            }
        }

        return (pixels, width);
    }

    private static byte Paeth(byte left, byte up, byte upLeft)
    {
        var p = left + up - upLeft;
        var dLeft = Math.Abs(p - left);
        var dUp = Math.Abs(p - up);
        var dUpLeft = Math.Abs(p - upLeft);
        return dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
    }
}
