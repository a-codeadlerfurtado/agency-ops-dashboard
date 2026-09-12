using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace RelatoAI.DesktopAgent;

internal sealed class WhatsAppDesktopCapture : IDisposable
{
    private readonly Func<AgentConfig?> configProvider;
    private readonly System.Threading.Timer timer;
    private WasapiRecorder? remoteRecorder;
    private WasapiRecorder? localRecorder;
    private WaveFileWriter? remoteWriter;
    private WaveFileWriter? localWriter;
    private Process? target;
    private readonly Queue<(DateTimeOffset at, byte[] data)> remoteRing = new();
    private readonly Queue<(DateTimeOffset at, byte[] data)> localRing = new();
    private readonly object gate = new();
    private DateTimeOffset? candidateAt;
    private DateTimeOffset lastRemoteActive = DateTimeOffset.MinValue;
    private DateTimeOffset lastLocalActive = DateTimeOffset.MinValue;
    private DateTimeOffset? callStarted;
    private string? sessionId;
    private string? remotePath;
    private string? localPath;
    private bool disposed;
    public event Action<string>? StatusChanged;
    public event Action<string, string>? CallStarted;
    public event Action<string, bool, string?>? CallFinished;

    public bool Enabled { get; set; } = true;
    public bool IsRecording => callStarted.HasValue;

    public WhatsAppDesktopCapture(Func<AgentConfig?> configProvider)
    {
        this.configProvider = configProvider;
        timer = new System.Threading.Timer(_ => TickSafe(), null, TimeSpan.Zero, TimeSpan.FromSeconds(1));
    }

    private void TickSafe()
    {
        if (disposed || !Enabled) return;
        try { Tick().GetAwaiter().GetResult(); }
        catch (Exception ex) { StatusChanged?.Invoke("Erro: " + ex.Message); }
    }

    private async Task Tick()
    {
        var process = FindWhatsApp();
        if (process is null)
        {
            if (IsRecording) await FinishCallAsync("whatsapp_process_closed");
            StopCaptureEngines();
            StatusChanged?.Invoke("Aguardando WhatsApp Desktop");
            return;
        }
        if (target?.Id != process.Id || remoteRecorder is null || localRecorder is null)
            await StartCaptureEnginesAsync(process);

        var now = DateTimeOffset.Now;
        var remoteHot = now - lastRemoteActive < TimeSpan.FromSeconds(2.5);
        var localHot = now - lastLocalActive < TimeSpan.FromSeconds(8);

        if (!IsRecording)
        {
            if (!remoteHot) { candidateAt = null; return; }
            candidateAt ??= now;
            var age = now - candidateAt.Value;
            if ((localHot && age > TimeSpan.FromSeconds(1)) || age > TimeSpan.FromSeconds(12))
                StartCall(process);
            return;
        }

        if (now - lastRemoteActive > TimeSpan.FromSeconds(45)
            && now - lastLocalActive > TimeSpan.FromSeconds(45))
            await FinishCallAsync("audio_inactive");
    }

    private static Process? FindWhatsApp()
    {
        var rows = Process.GetProcessesByName("WhatsApp");
        return rows.OrderByDescending(p => p.MainWindowHandle != IntPtr.Zero)
            .ThenByDescending(p => !string.IsNullOrWhiteSpace(p.MainWindowTitle))
            .FirstOrDefault();
    }

    private async Task StartCaptureEnginesAsync(Process process)
    {
        StopCaptureEngines();
        target = process;
        remoteRecorder = await new WasapiRecorderBuilder()
            .WithProcessLoopback((uint)process.Id, ProcessLoopbackMode.IncludeTargetProcessTree)
            .BuildAsync();
        remoteRecorder.DataAvailable += (buffer, _, _, _) =>
        {
            var bytes = buffer.ToArray();
            OnAudio("remote", bytes, remoteRecorder.WaveFormat);
        };

        using var devices = new MMDeviceEnumerator();
        var mic = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        localRecorder = new WasapiRecorderBuilder().WithDevice(mic).Build();
        localRecorder.DataAvailable += (buffer, _, _, _) =>
        {
            var bytes = buffer.ToArray();
            OnAudio("local", bytes, localRecorder.WaveFormat);
        };
        remoteRecorder.StartRecording();
        localRecorder.StartRecording();
        StatusChanged?.Invoke("WhatsApp Desktop monitorado");
    }

    private void OnAudio(string role, byte[] bytes, WaveFormat format)
    {
        var now = DateTimeOffset.Now;
        lock (gate)
        {
            var ring = role == "remote" ? remoteRing : localRing;
            ring.Enqueue((now, bytes));
            while (ring.Count > 0 && now - ring.Peek().at > TimeSpan.FromSeconds(10)) ring.Dequeue();
            if (AudioLevel.IsActive(bytes, format, role == "remote" ? 0.0025 : 0.015))
            {
                if (role == "remote") lastRemoteActive = now;
                else lastLocalActive = now;
            }
            if (IsRecording)
            {
                if (role == "remote") remoteWriter?.Write(bytes, 0, bytes.Length);
                else localWriter?.Write(bytes, 0, bytes.Length);
            }
        }
    }

    private void StartCall(Process process)
    {
        if (remoteRecorder is null || localRecorder is null || IsRecording) return;
        var now = DateTimeOffset.Now;
        sessionId = $"wa-desktop-{now:yyyyMMddHHmmss}-{Guid.NewGuid():N}";
        callStarted = now;
        var dir = Path.Combine(Path.GetTempPath(), "RelatoAI", sessionId);
        Directory.CreateDirectory(dir);
        remotePath = Path.Combine(dir, "remote.wav");
        localPath = Path.Combine(dir, "local.wav");
        remoteWriter = new WaveFileWriter(remotePath, remoteRecorder.WaveFormat);
        localWriter = new WaveFileWriter(localPath, localRecorder.WaveFormat);
        lock (gate)
        {
            foreach (var row in remoteRing) remoteWriter.Write(row.data, 0, row.data.Length);
            foreach (var row in localRing) localWriter.Write(row.data, 0, row.data.Length);
        }
        candidateAt = null;
        var contact = ResolveContactName(process);
        CallStarted?.Invoke(sessionId, contact);
        StatusChanged?.Invoke("REC · chamada WhatsApp Desktop");
    }

    public Task FinishManualAsync() => FinishCallAsync("manual_stop");

    private async Task FinishCallAsync(string reason)
    {
        if (!IsRecording || sessionId is null || callStarted is null) return;
        var id = sessionId;
        var started = callStarted.Value;
        var ended = DateTimeOffset.Now;
        var contact = ResolveContactName(target);
        lock (gate)
        {
            remoteWriter?.Dispose(); remoteWriter = null;
            localWriter?.Dispose(); localWriter = null;
        }
        sessionId = null; callStarted = null; candidateAt = null;
        var success = false; string? error = null;
        try
        {
            var cfg = configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
            var api = new RelatoApi(cfg);
            var roles = new List<string>();
            if (remotePath is not null && File.Exists(remotePath) && new FileInfo(remotePath).Length > 1000) roles.Add("remote");
            if (localPath is not null && File.Exists(localPath) && new FileInfo(localPath).Length > 1000) roles.Add("local");
            if (roles.Count == 0) throw new InvalidOperationException("Nenhum áudio capturado");
            var prepared = await api.PrepareCallAsync(id, started, ended, contact, roles);
            var uploaded = new List<object>();
            foreach (var targetUpload in prepared.Uploads)
            {
                var file = targetUpload.Role == "local" ? localPath : remotePath;
                if (file is null || !File.Exists(file)) continue;
                await api.UploadAsync(targetUpload.SignedUrl, file);
                uploaded.Add(new { role = targetUpload.Role, path = targetUpload.Path, bytes = new FileInfo(file).Length, mime_type = "audio/wav" });
            }
            await api.FinalizeCallAsync(id, uploaded);
            success = true;
            CallFinished?.Invoke(id, true, null);
            _ = Task.Run(() => CleanupFiles(remotePath, localPath));
        }
        catch (Exception ex)
        {
            error = ex.Message;
            CallFinished?.Invoke(id, false, error);
        }
        finally
        {
            StatusChanged?.Invoke(success ? "Ligação enviada ao Relato AI" : "Falha ao enviar ligação");
            remotePath = null; localPath = null;
        }
    }

    private static string ResolveContactName(Process? process)
    {
        var title = process?.MainWindowTitle?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(title) || title.Equals("WhatsApp", StringComparison.OrdinalIgnoreCase))
            return "Contato WhatsApp Desktop";
        return title.Length > 160 ? title[..160] : title;
    }

    private static void CleanupFiles(params string?[] paths)
    {
        foreach (var path in paths)
        {
            try { if (!string.IsNullOrWhiteSpace(path) && File.Exists(path)) File.Delete(path); }
            catch { }
        }
    }
    private void StopCaptureEngines()
    {
        try { remoteRecorder?.StopRecording(); } catch { }
        try { localRecorder?.StopRecording(); } catch { }
        remoteRecorder?.Dispose(); remoteRecorder = null;
        localRecorder?.Dispose(); localRecorder = null;
        target = null;
        candidateAt = null;
        remoteRing.Clear(); localRing.Clear();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        timer.Dispose();
        if (IsRecording) FinishCallAsync("agent_exit").GetAwaiter().GetResult();
        StopCaptureEngines();
        lock (gate)
        {
            remoteWriter?.Dispose(); remoteWriter = null;
            localWriter?.Dispose(); localWriter = null;
        }
    }
}