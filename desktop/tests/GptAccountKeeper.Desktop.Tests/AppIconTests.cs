using GptAccountKeeper.Desktop.Application;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

public sealed class AppIconTests
{
    [Fact]
    public void EmbeddedIconIsAValidPngResource()
    {
        var bytes = AppIcon.GetPngBytes();
        Assert.True(bytes.Length > 64);
        Assert.Equal(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, bytes[..8]);
    }
}
