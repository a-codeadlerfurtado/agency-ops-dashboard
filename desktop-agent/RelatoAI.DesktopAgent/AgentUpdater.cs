using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Win32;

namespace RelatoAI.DesktopAgent;

internal sealed class AgentUpdater : IDisposable
{
    public const string CurrentVersion = "desktop-0.4.9";
    private readonly Func<AgentConfig?> configProvider;
    private readonly Action<string> status;
    private readonly Action exitAgent;
    private readonly System.Threading.Timer timer;
    private int checking;
    private bool disposed;

    public AgentUpdater(Func<AgentConfig?> configProvider, Action<string> status, Action exitAgent)
    {
        this.configProvider = configProvider;
        this.status = status;
        this.exitAgent = exitAgent;
        timer = new System.Threading.Timer(_ => _ = CheckAsync(), null,
            TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(15));
    }

    private async Task CheckAsync()
    {
        if (disposed || Interlocked.Exchange(ref checking, 1) != 0) return;
        try
        {
            var cfg = configProvider();
            if (cfg is null) return;
            var info = await new RelatoApi(cfg).GetUpdateInfoAsync(CurrentVersion);
            if (!info.UpdateRequired || string.IsNullOrWhiteSpace(info.DownloadUrl)) return;
            status($"Atualizando Relato AI para {info.RequiredVersion}...");
            await InstallAsync(info);
        }
        catch (Exception ex)
        {
            status("Falha ao verificar atualização: " + ex.Message);
        }
        finally
        {
            Interlocked.Exchange(ref checking, 0);
        }
    }

    private async Task InstallAsync(AgentUpdateInfo info)
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RelatoAI");
        var updates = Path.Combine(root, "updates");
        Directory.CreateDirectory(updates);

        var tempExe = Path.Combine(updates, "RelatoAI-Desktop-SDR.new.exe");
        var targetExe = Path.Combine(root, "RelatoAI-Desktop-SDR.exe");

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        var bytes = await http.GetByteArrayAsync(info.DownloadUrl);
        await File.WriteAllBytesAsync(tempExe, bytes);
        var actualHash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var expectedHash = (info.Sha256 ?? "").Replace("sha256:", "", StringComparison.OrdinalIgnoreCase)
            .Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(expectedHash) || !actualHash.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Hash da atualização não confere.");

        var scriptPath = Path.Combine(updates, "apply-update.cmd");
        var currentPid = Environment.ProcessId;
        var script = $"""
@echo off
setlocal
:wait
tasklist /FI "PID eq {currentPid}" | find "{currentPid}" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
copy /Y "{tempExe}" "{targetExe}" >nul
start "" "{targetExe}"
del /Q "{tempExe}" >nul 2>&1
del "%~f0"
""";
        await File.WriteAllTextAsync(scriptPath, script);

        var quote = Convert.ToChar(34).ToString();
        using (var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            run?.SetValue("RelatoAI", quote + targetExe + quote);

        var cmdArgs = "/c start " + quote + quote + " " + quote + scriptPath + quote;
        Process.Start(new ProcessStartInfo("cmd.exe", cmdArgs)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
        status($"Relato AI {info.RequiredVersion} baixado. Reiniciando...");
        exitAgent();
    }

    public void Dispose()
    {
        disposed = true;
        timer.Dispose();
    }
}
