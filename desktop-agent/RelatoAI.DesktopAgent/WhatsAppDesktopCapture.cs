using System.Diagnostics;
using Microsoft.Win32;
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
    private bool callPrivacyObservedActive;
    private long callPrivacyStart;
    private string? sessionId;
    private string? remotePath;
    private string? localPath;
    private bool disposed;
    private volatile bool captureRestartRequested;
    private bool stoppingCaptureEngines;
    private DateTimeOffset? uiIdentityLastProbe;
    private WhatsAppDesktopUiIdentity? uiIdentity;
    private int ticking;
    public event Action<string>? StatusChanged;
    public event Action<string, string>? CallStarted;
    public event Action<string, string>? CallEnded;
    public event Action<string, bool, string?>? CallFinished;

    public bool Enabled { get; set; } = true;
    public bool IsRecording => callStarted.HasValue;

    public WhatsAppDesktopCapture(Func<AgentConfig?> configProvider)
    {
        this.configProvider = configProvider;
        // Give AgentContext time to subscribe to StatusChanged/Call events before the first tick.
        timer = new System.Threading.Timer(_ => TickSafe(), null, TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(250));
    }

    private void TickSafe()
    {
        if (disposed || !Enabled || Interlocked.Exchange(ref ticking, 1) == 1) return;
        try { Tick().GetAwaiter().GetResult(); }
        catch (Exception ex) { StatusChanged?.Invoke("Erro: " + ex.Message); }
        finally { Volatile.Write(ref ticking, 0); }
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
        if (target?.Id != process.Id || remoteRecorder is null || localRecorder is null || captureRestartRequested)
        {
            captureRestartRequested = false;
            await StartCaptureEnginesAsync(process);
        }

        var now = DateTimeOffset.Now;
        var remoteHot = now - lastRemoteActive < TimeSpan.FromSeconds(2.5);
        var localHot = now - lastLocalActive < TimeSpan.FromSeconds(8);
        var micUsage = ReadWhatsAppMicrophoneUsage();

        if (!IsRecording)
        {
            if (micUsage.Available)
            {
                candidateAt = null;
                if (micUsage.Active) StartCall(process, micUsage.Start);
                return;
            }
            if (!remoteHot) { candidateAt = null; return; }
            candidateAt ??= now;
            var age = now - candidateAt.Value;
            if ((localHot && age > TimeSpan.FromSeconds(1)) || age > TimeSpan.FromSeconds(12))
                StartCall(process);
            return;
        }

        if (IsRecording && (uiIdentityLastProbe is null || now - uiIdentityLastProbe.Value > TimeSpan.FromSeconds(1.5)))
        {
            uiIdentityLastProbe = now;
            var direct = WhatsAppDesktopUiIdentityResolver.TryResolve();
            if (direct is not null && (uiIdentity is null || direct.Confidence >= uiIdentity.Confidence))
            {
                uiIdentity = direct;
                if (!string.IsNullOrWhiteSpace(direct.Name) || !string.IsNullOrWhiteSpace(direct.Phone))
                    StatusChanged?.Invoke("REC · contato identificado direto no WhatsApp Desktop");
            }
        }

        if (micUsage.Available && micUsage.Active)
        {
            if (!callPrivacyObservedActive || callPrivacyStart != micUsage.Start)
                StatusChanged?.Invoke("REC · chamada WhatsApp Desktop · Windows confirmou call ativa");
            callPrivacyObservedActive = true;
            callPrivacyStart = micUsage.Start;
        }
        else if (micUsage.Available && callPrivacyObservedActive
            && callPrivacyStart > 0 && micUsage.Stop >= callPrivacyStart)
        {
            await FinishCallAsync("windows_mic_released", micUsage.Stop);
            return;
        }

        // Safety fallback only. The privacy usage record is the primary hangup signal.
        if (!micUsage.Available && !callPrivacyObservedActive
            && now - lastRemoteActive > TimeSpan.FromSeconds(45)
            && now - lastLocalActive > TimeSpan.FromSeconds(45))
            await FinishCallAsync("audio_inactive_fallback");
    }

    private readonly record struct MicUsageSnapshot(bool Available, bool Active, long Start, long Stop);

    private static MicUsageSnapshot ReadWhatsAppMicrophoneUsage()
    {
        const string rootPath = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        try
        {
            using var root = Registry.CurrentUser.OpenSubKey(rootPath);
            if (root is null) return new(false, false, 0, 0);
            var subName = root.GetSubKeyNames()
                .FirstOrDefault(x => x.Contains("WhatsAppDesktop", StringComparison.OrdinalIgnoreCase));
            if (string.IsNullOrWhiteSpace(subName)) return new(false, false, 0, 0);
            using var key = root.OpenSubKey(subName);
            var start = Convert.ToInt64(key?.GetValue("LastUsedTimeStart") ?? 0L);
            var stop = Convert.ToInt64(key?.GetValue("LastUsedTimeStop") ?? 0L);
            return new(true, start > 0 && start > stop, start, stop);
        }
        catch { return new(false, false, 0, 0); }
    }

    private static bool IsWhatsAppCaptureSessionActive()
    {
        try
        {
            var whatsappPids = GetWhatsAppProcessTreePids();
            if (whatsappPids.Count == 0) return false;

            using var devices = new MMDeviceEnumerator();
            foreach (var device in devices.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
            {
                try
                {
                    var sessions = device.AudioSessionManager.Sessions;
                    for (var i = 0; i < sessions.Count; i++)
                    {
                        using var session = sessions[i];
                        if (whatsappPids.Contains(session.GetProcessID)
                            && string.Equals(session.State.ToString(), "AudioSessionStateActive", StringComparison.Ordinal))
                            return true;
                    }
                }
                catch { }
            }
        }
        catch { }
        return false;
    }

    private static HashSet<uint> GetWhatsAppProcessTreePids()
    {
        var ids = Process.GetProcesses()
            .Where(p => p.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase))
            .Select(p => (uint)p.Id)
            .ToHashSet();
        if (ids.Count == 0) return ids;

        var snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snapshot == new IntPtr(-1)) return ids;
        try
        {
            var rows = new List<(uint pid, uint parent)>();
            var entry = new PROCESSENTRY32 { dwSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<PROCESSENTRY32>() };
            if (Process32First(snapshot, ref entry))
            {
                do { rows.Add((entry.th32ProcessID, entry.th32ParentProcessID)); }
                while (Process32Next(snapshot, ref entry));
            }
            var changed = true;
            while (changed)
            {
                changed = false;
                foreach (var row in rows)
                    if (ids.Contains(row.parent) && ids.Add(row.pid)) changed = true;
            }
        }
        finally { CloseHandle(snapshot); }
        return ids;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Process? FindWhatsApp()
    {
        // The current Microsoft Store build runs as WhatsApp.Root.exe, while
        // older desktop builds use WhatsApp.exe. Match the whole WhatsApp
        // process family so automatic capture survives app updates.
        var rows = Process.GetProcesses()
            .Where(p => p.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        return rows.OrderByDescending(p => p.MainWindowHandle != IntPtr.Zero)
            .ThenByDescending(p => string.Equals(p.MainWindowTitle, "WhatsApp", StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(p => !string.IsNullOrWhiteSpace(p.MainWindowTitle))
            .FirstOrDefault();
    }

    private async Task StartCaptureEnginesAsync(Process process)
    {
        StopCaptureEngines();
        target = process;

        using var devices = new MMDeviceEnumerator();
        var render = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Communications);
        var mic = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);

        // Capturar o dispositivo de saída inteiro é mais estável no WhatsApp da Microsoft Store
        // do que prender o loopback ao PID, que pode trocar de processo durante a call.
        remoteRecorder = new WasapiRecorderBuilder().WithDevice(render).WithLoopbackCapture().Build();
        remoteRecorder.DataAvailable += (buffer, _, _, _) =>
        {
            var bytes = buffer.ToArray();
            OnAudio("remote", bytes, remoteRecorder.WaveFormat);
        };
        remoteRecorder.RecordingStopped += (_, e) =>
        {
            if (!stoppingCaptureEngines && !disposed)
            {
                captureRestartRequested = true;
                StatusChanged?.Invoke("Reconectando áudio remoto do WhatsApp...");
            }
            if (e.Exception is not null) StatusChanged?.Invoke("Erro no áudio remoto: " + e.Exception.Message);
        };

        localRecorder = new WasapiRecorderBuilder().WithDevice(mic).WithCommunicationsMode().Build();
        localRecorder.DataAvailable += (buffer, _, _, _) =>
        {
            var bytes = buffer.ToArray();
            OnAudio("local", bytes, localRecorder.WaveFormat);
        };
        localRecorder.RecordingStopped += (_, e) =>
        {
            if (!stoppingCaptureEngines && !disposed)
            {
                captureRestartRequested = true;
                StatusChanged?.Invoke("Reconectando microfone do WhatsApp...");
            }
            if (e.Exception is not null) StatusChanged?.Invoke("Erro no microfone: " + e.Exception.Message);
        };

        remoteRecorder.StartRecording();
        localRecorder.StartRecording();
        await Task.CompletedTask;
        StatusChanged?.Invoke(IsRecording ? "REC · captura de áudio reconectada" : "WhatsApp Desktop monitorado");
    }

    private void OnAudio(string role, byte[] bytes, WaveFormat format)
    {
        var now = DateTimeOffset.Now;
        lock (gate)
        {
            var ring = role == "remote" ? remoteRing : localRing;
            ring.Enqueue((now, bytes));
            while (ring.Count > 0 && now - ring.Peek().at > TimeSpan.FromSeconds(3)) ring.Dequeue();
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

    private void StartCall(Process process, long privacyStart = 0)
    {
        if (remoteRecorder is null || localRecorder is null || IsRecording) return;
        var now = DateTimeOffset.Now;
        var detectedStart = ResolvePrivacyTime(privacyStart, now);
        sessionId = $"wa-desktop-{now:yyyyMMddHHmmss}-{Guid.NewGuid():N}";
        callStarted = detectedStart;
        callPrivacyObservedActive = privacyStart > 0;
        callPrivacyStart = privacyStart;
        uiIdentityLastProbe = null;
        uiIdentity = WhatsAppDesktopUiIdentityResolver.TryResolve();
        var dir = Path.Combine(Path.GetTempPath(), "RelatoAI", sessionId);
        Directory.CreateDirectory(dir);
        remotePath = Path.Combine(dir, "remote.wav");
        localPath = Path.Combine(dir, "local.wav");
        remoteWriter = new WaveFileWriter(remotePath, remoteRecorder.WaveFormat);
        localWriter = new WaveFileWriter(localPath, localRecorder.WaveFormat);
        var keepFrom = privacyStart > 0 ? detectedStart - TimeSpan.FromMilliseconds(500) : now - TimeSpan.FromSeconds(2);
        lock (gate)
        {
            foreach (var row in remoteRing.Where(row => row.at >= keepFrom)) remoteWriter.Write(row.data, 0, row.data.Length);
            foreach (var row in localRing.Where(row => row.at >= keepFrom)) localWriter.Write(row.data, 0, row.data.Length);
        }
        candidateAt = null;
        var contact = ResolveContactName(process);
        CallStarted?.Invoke(sessionId, contact);
        StatusChanged?.Invoke(callPrivacyObservedActive
            ? "REC · chamada WhatsApp Desktop · Windows confirmou call ativa"
            : "REC · chamada WhatsApp Desktop · aguardando confirmação do Windows");
    }

    public Task FinishManualAsync() => FinishCallAsync("manual_stop");

    private async Task FinishCallAsync(string reason, long privacyStop = 0)
    {
        if (!IsRecording || sessionId is null || callStarted is null) return;
        var id = sessionId;
        var started = callStarted.Value;
        var now = DateTimeOffset.Now;
        var ended = ResolvePrivacyTime(privacyStop, now);
        if (ended <= started || ended - started > TimeSpan.FromHours(12)) ended = now;
        var finalUiIdentity = WhatsAppDesktopUiIdentityResolver.TryResolve();
        if (finalUiIdentity is not null && (uiIdentity is null || finalUiIdentity.Confidence >= uiIdentity.Confidence))
            uiIdentity = finalUiIdentity;
        var contact = !string.IsNullOrWhiteSpace(uiIdentity?.Name) ? uiIdentity!.Name! : ResolveContactName(target);
        lock (gate)
        {
            remoteWriter?.Dispose(); remoteWriter = null;
            localWriter?.Dispose(); localWriter = null;
        }
        sessionId = null; callStarted = null; candidateAt = null;
        callPrivacyObservedActive = false;
        callPrivacyStart = 0;
        StatusChanged?.Invoke(reason == "windows_mic_released"
            ? "Ligação encerrada automaticamente pelo Windows"
            : $"Ligação encerrada ({reason})");
        CallEnded?.Invoke(id, contact);
        var success = false; string? error = null;
        try
        {
            var cfg = AgentConfig.Load() ?? configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
            var fallbackIdentity = await WhatsAppCallIdentityResolver.ResolveAsync(started, ended, cfg.LocalPhone, contact);
            var directName = uiIdentity?.Name?.Trim();
            var directPhone = uiIdentity?.Phone?.Trim();
            var identity = new WhatsAppCallIdentity(
                fallbackIdentity.LocalPhone,
                string.IsNullOrWhiteSpace(directPhone) ? fallbackIdentity.RemotePhone : directPhone,
                string.IsNullOrWhiteSpace(directName) ? fallbackIdentity.RemoteName : directName,
                (!string.IsNullOrWhiteSpace(directName) || !string.IsNullOrWhiteSpace(directPhone))
                    ? "WHATSAPP_DESKTOP_UIA"
                    : fallbackIdentity.Source);
            var resolvedContact = string.IsNullOrWhiteSpace(identity.RemoteName) ? contact : identity.RemoteName.Trim();
            if (!string.IsNullOrWhiteSpace(identity.LocalPhone) && identity.LocalPhone != cfg.LocalPhone)
            {
                cfg = cfg with { LocalPhone = identity.LocalPhone };
                cfg.Save();
            }
            var api = new RelatoApi(cfg);
            var durationMs = Math.Max(0L, (long)Math.Round((ended - started).TotalMilliseconds));
            var roles = new List<string>();
            if (remotePath is not null && File.Exists(remotePath) && new FileInfo(remotePath).Length > 1000) roles.Add("remote");
            if (localPath is not null && File.Exists(localPath) && new FileInfo(localPath).Length > 1000) roles.Add("local");
            if (roles.Count == 0) throw new InvalidOperationException("Nenhum áudio capturado");

            // Do not block finalization on local MP3 encoding. Upload the two raw
            // channels immediately; the heavy worker mixes them with ffmpeg before STT.
            var prepared = await api.PrepareCallAsync(
                id, started, ended, resolvedContact, roles, durationMs,
                identity.LocalPhone, identity.RemotePhone, identity.Source);

            var uploadTasks = prepared.Uploads.Select(async targetUpload =>
            {
                string? file = targetUpload.Role switch
                {
                    "local" => localPath,
                    "remote" => remotePath,
                    _ => null
                };
                if (file is null || !File.Exists(file)) return (object?)null;
                const string mime = "audio/wav";
                await api.UploadAsync(targetUpload.SignedUrl, file, mime);
                var fileBytes = new FileInfo(file).Length;
                return (object)new { role = targetUpload.Role, path = targetUpload.Path, bytes = fileBytes, mime_type = mime };
            }).ToArray();

            var uploaded = (await Task.WhenAll(uploadTasks))
                .Where(item => item is not null)
                .Cast<object>()
                .ToList();
            await api.FinalizeCallAsync(id, uploaded, durationMs);
            success = true;
            CallFinished?.Invoke(id, true, null);
            _ = Task.Run(() => CleanupFiles(remotePath, localPath, Path.Combine(Path.GetDirectoryName(localPath ?? remotePath ?? "") ?? "", "meeting.mp3")));
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
            uiIdentity = null;
            uiIdentityLastProbe = null;
        }
    }

    private static DateTimeOffset ResolvePrivacyTime(long rawFileTime, DateTimeOffset fallback)
    {
        if (rawFileTime <= 0) return fallback;
        try
        {
            var value = new DateTimeOffset(DateTime.FromFileTimeUtc(rawFileTime)).ToLocalTime();
            return Math.Abs((value - fallback).TotalHours) <= 12 ? value : fallback;
        }
        catch { return fallback; }
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
        stoppingCaptureEngines = true;
        try
        {
            try { remoteRecorder?.StopRecording(); } catch { }
            try { localRecorder?.StopRecording(); } catch { }
            remoteRecorder?.Dispose(); remoteRecorder = null;
            localRecorder?.Dispose(); localRecorder = null;
        }
        finally
        {
            stoppingCaptureEngines = false;
        }
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
