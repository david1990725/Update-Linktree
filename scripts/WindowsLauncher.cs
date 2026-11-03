using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

public static class WindowsLauncher
{
    [STAThread]
    public static void Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "scripts", "windows-launch.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("請將此程式放在專案資料夾內。", script);
            var start = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = root;
            Process.Start(start);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "每月活動同步", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
