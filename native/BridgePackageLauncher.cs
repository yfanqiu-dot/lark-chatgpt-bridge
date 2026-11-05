using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Build as a Windows GUI-subsystem application. It creates no window and
// starts the existing broker with CREATE_NO_WINDOW through ProcessStartInfo.
// No shell, breakaway, credential handling or broker lifetime policy lives here.
public static class BridgePackageLauncher
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);

    public static string PackageIdentity()
    {
        uint length = 0;
        int code = GetCurrentPackageFullName(ref length, null);
        if (code != 122) throw new Win32Exception(code);
        var name = new StringBuilder((int)length);
        code = GetCurrentPackageFullName(ref length, name);
        if (code != 0) throw new Win32Exception(code);
        if (!name.ToString().StartsWith("OpenAI.Codex_", StringComparison.Ordinal)
            || !name.ToString().EndsWith("_x64__2p2nqsd0c76g0", StringComparison.Ordinal))
            throw new InvalidOperationException("Unexpected package identity");
        return name.ToString();
    }

    // Windows argv quoting, including trailing backslashes and embedded quotes.
    public static string Quote(string value)
    {
        if (value == null) throw new ArgumentNullException("value");
        if (value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            throw new ArgumentException("Control characters are not allowed");
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            text.Append(character); slashes = 0;
        }
        text.Append('\\', slashes * 2); text.Append('"');
        return text.ToString();
    }

    public static ProcessStartInfo CreateStartInfo(string script, string[] args)
    {
        if (!Path.IsPathRooted(script) || !File.Exists(script))
            throw new ArgumentException("An existing absolute script is required");
        var arguments = new StringBuilder("-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File ");
        arguments.Append(Quote(script));
        foreach (string argument in args) arguments.Append(' ').Append(Quote(argument));
        return new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = arguments.ToString(),
            WorkingDirectory = Path.GetDirectoryName(script),
            UseShellExecute = false,
            CreateNoWindow = true,
            ErrorDialog = false,
            WindowStyle = ProcessWindowStyle.Hidden
        };
    }

    public static int Run(ProcessStartInfo info)
    {
        // Reject ordinary, unpackaged execution rather than silently losing
        // the package identity required by the original broker checks.
        PackageIdentity();
        using (Process child = Process.Start(info))
        {
            if (child == null) return 3;
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "desktop-package-broker.ps1");
            return Run(CreateStartInfo(script, args));
        }
        catch
        {
            // Never display a dialog or expose command text/capability paths.
            return 2;
        }
    }
}
