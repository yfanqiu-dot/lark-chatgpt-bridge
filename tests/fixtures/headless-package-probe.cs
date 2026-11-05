using System;
using System.Linq;

// Uses the production launch implementation with a finite, read-only probe
// script. Its name deliberately does not match any Bridge runtime role.
public static class BridgeHeadlessProbe
{
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            return BridgePackageLauncher.Run(
                BridgePackageLauncher.CreateStartInfo(args[0], args.Skip(1).ToArray()));
        }
        catch { return 2; }
    }
}
