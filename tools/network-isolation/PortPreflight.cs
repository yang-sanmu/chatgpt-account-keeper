using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Text.RegularExpressions;

namespace GptAccountKeeper.NetworkIsolation;

internal readonly record struct PortRange(int Start, int End)
{
    internal bool Contains(int port) => port >= Start && port <= End;
    internal void Validate() { if (Start < 1 || End > 65535 || End < Start) throw new ArgumentException("Invalid port range"); }
}

internal sealed record PortInventory(PortRange[] Dynamic, PortRange[] Excluded, HashSet<int> Occupied)
{
    internal void Check(IEnumerable<ushort> ports)
    {
        foreach (var port in ports)
        {
            if (port < 1024 || Dynamic.Any(range => range.Contains(port)) || Excluded.Any(range => range.Contains(port))
                || Occupied.Contains(port)) throw new ArgumentException($"Listener port {port} is privileged, dynamic, excluded or occupied; choose a new candidate");
        }
    }
}

// Read-only preflight. It does not reserve ports and cannot replace the future
// coordinator's admission lock/recheck at bind time. It never changes host ranges.
internal static class PortPreflight
{
    internal static PortInventory Read()
    {
        var dynamic = new List<PortRange>(); var excluded = new List<PortRange>();
        foreach (var family in new[] { "ipv4", "ipv6" })
        {
            dynamic.Add(ParseDynamic(Netsh(family, "dynamicportrange")));
            excluded.AddRange(ParseExcluded(Netsh(family, "excludedportrange")));
        }
        var properties = IPGlobalProperties.GetIPGlobalProperties();
        var occupied = properties.GetActiveTcpListeners().Select(endpoint => endpoint.Port)
            .Concat(properties.GetActiveTcpConnections().Select(connection => connection.LocalEndPoint.Port)).ToHashSet();
        return new PortInventory(dynamic.ToArray(), excluded.ToArray(), occupied);
    }
    private static string Netsh(string family, string query)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "netsh.exe")) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var argument in new[] { "interface", family, "show", query, "protocol=tcp" }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Cannot query port ranges");
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(5000)) { process.Kill(); throw new InvalidOperationException("Port inventory query timed out"); }
        if (process.ExitCode != 0) throw new InvalidOperationException("Cannot confirm host port ranges");
        _ = error.GetAwaiter().GetResult();
        return output.GetAwaiter().GetResult();
    }
    internal static PortRange ParseDynamic(string output)
    {
        // Labels are localized. Only accept the two numeric labelled rows, in
        // the documented start/count order, with a valid resulting interval.
        var values = Regex.Matches(output, @"(?m)^.*[:：]\s*(\d+)\s*\r?$")
            .Select(match => int.Parse(match.Groups[1].Value)).ToArray();
        if (values.Length != 2 || values[1] < 1) throw new ArgumentException("Unrecognized dynamic port output");
        var range = new PortRange(values[0], checked(values[0] + values[1] - 1)); range.Validate(); return range;
    }
    internal static PortRange[] ParseExcluded(string output)
    {
        if (!Regex.IsMatch(output, @"(?m)^\s*-+\s+-+\s*\r?$")) throw new ArgumentException("Unrecognized exclusion table");
        var result = new List<PortRange>();
        foreach (var line in output.Split('\n'))
        {
            if (!Regex.IsMatch(line, @"^\s*\d")) continue;
            var match = Regex.Match(line, @"^\s*(\d+)\s+(\d+)\s*\*?\s*$");
            if (!match.Success) throw new ArgumentException("Unrecognized exclusion row");
            var range = new PortRange(int.Parse(match.Groups[1].Value), int.Parse(match.Groups[2].Value));
            range.Validate(); result.Add(range);
        }
        return result.ToArray();
    }
}
