using System.Xml.Linq;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

public sealed class PackagingMetadataTests
{
    [Fact]
    public void InfoPlistStampRunsForEveryBuildAndUsesTheRequestedVersion()
    {
        var project = XDocument.Load(PackagingIconAssets.DesktopProject);
        var target = Assert.Single(
            project.Descendants("Target"),
            element => string.Equals(
                (string?)element.Attribute("Name"),
                "StampInfoPlist",
                StringComparison.Ordinal));

        Assert.Null(target.Attribute("Inputs"));
        Assert.Null(target.Attribute("Outputs"));
        Assert.Contains("$(Version)", target.ToString(SaveOptions.DisableFormatting));

        var write = Assert.Single(target.Descendants("WriteLinesToFile"));
        Assert.Equal("true", (string?)write.Attribute("Overwrite"));
        Assert.Equal("true", (string?)write.Attribute("WriteOnlyWhenDifferent"));
    }
}
