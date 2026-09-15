using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace RelatoAI.DesktopAgent;

internal sealed record MeetStartRequest(
    string LocalSessionId, string MeetingCode, string MeetingUrl, string Title,
    DateTimeOffset StartedAt, IReadOnlyList<string>? Participants = null);
internal sealed record MeetSpeakerRequest(string? Name, DateTimeOffset At, double Confidence = 1);
internal sealed record MeetStateRequest(IReadOnlyList<string>? Participants = null, string? ActiveSpeaker = null, double Confidence = 1);
internal sealed record MeetLiveSegment(long Seq, string SpeakerName, string Text, int StartedMs, int EndedMs, string Role);
internal sealed record MeetHealth(
    bool Recording, string? SessionId, int Segments, string? RemoteSpeaker,
    int PendingTranscriptions, double LocalRms, double RemoteRms);

internal sealed class MeetDesktopCaptureV2 : IDisposable
{
    private sealed class ChunkState
    {
        public MemoryStream Buffer { get; } = new();
        public WaveFormat? Format { get; set; }
        public DateTimeOffset StartedAt { get; set; }
        public double TotalMs { get; set; }
        public double VoicedMs { get; set; }
        public double SilenceMs { get; set; }
        public double CurrentVoicedRunMs { get; set; }
        public double MaxVoicedRunMs { get; set; }
        public double PeakRms { get; set; }
        public long LastVoicedByte { get; set; } = -1;
        public bool Active { get; set; }
        public Dictionary<string, double> SpeakerMs { get; } = new(StringComparer.OrdinalIgnoreCase);
        public void Reset(DateTimeOffset now)
        {
            Buffer.SetLength(0); Format = null; StartedAt = now; TotalMs = 0; VoicedMs = 0; SilenceMs = 0;
            CurrentVoicedRunMs = 0; MaxVoicedRunMs = 0; PeakRms = 0; LastVoicedByte = -1; Active = false; SpeakerMs.Clear();
        }
    }

    private readonly Func<AgentConfig?> configProvider;
    private readonly object gate = new();
    private readonly SemaphoreSlim sttSlots = new(2, 2);
    private readonly List<Task> pending = [];
    private readonly List<MeetLiveSegment> segments = [];
    private readonly List<string> participants = [];
    private readonly ChunkState localChunk = new();
    private readonly ChunkState remoteChunk = new();
    private WasapiRecorder? localRecorder;
    private WasapiRecorder? remoteRecorder;
    private WaveFileWriter? localWriter;
    private WaveFileWriter? remoteWriter;
    private MeetStartRequest? current;
    private string? localPath;
    private string? remotePath;
    private string? remoteSpeaker;
    private DateTimeOffset remoteSpeakerAt;
    private double remoteSpeakerConfidence;
    private long segmentSeq;
    private double lastLocalRms;
    private double lastRemoteRms;
    private bool disposed;

    public event Action<string>? StatusChanged;
    public event Action<string>? MeetingStarted;
    public event Action<string, bool, string?>? MeetingFinished;
    public bool IsRecording => current is not null;

    public MeetDesktopCaptureV2(Func<AgentConfig?> configProvider) => this.configProvider = configProvider;

    public async Task StartAsync(MeetStartRequest request)
    {
        if (disposed) throw new ObjectDisposedException(nameof(MeetDesktopCaptureV2));
        if (current is not null) await FinishAsync("replaced_by_new_meeting");
        var cfg = configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
        current = request; segmentSeq = 0; lastLocalRms = 0; lastRemoteRms = 0;
        lock (gate)
        {
            segments.Clear(); participants.Clear();
            if (request.Participants is not null) participants.AddRange(request.Participants.Where(ValidName).Distinct(StringComparer.OrdinalIgnoreCase));
            localChunk.Reset(request.StartedAt); remoteChunk.Reset(request.StartedAt);
            remoteSpeaker = null; remoteSpeakerAt = DateTimeOffset.MinValue; remoteSpeakerConfidence = 0;
        }
        var dir = Path.Combine(Path.GetTempPath(), "RelatoAI", request.LocalSessionId);
        Directory.CreateDirectory(dir);
        localPath = Path.Combine(dir, "local.wav"); remotePath = Path.Combine(dir, "remote.wav");
        StartRecorders();
        MeetingStarted?.Invoke(request.MeetingCode);
        StatusChanged?.Invoke($"REC · Google Meet · {request.MeetingCode} · Desktop Agent 0.5");
        _ = new MeetRelatoApi(cfg).HeartbeatMeetingAsync(request, "CAPTURING", new { recorder = "DESKTOP_AGENT", roles = new[] { "local", "remote" } });
    }

    private void StartRecorders()
    {
        StopRecorders();
        using var devices = new MMDeviceEnumerator();
        var mic = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        var render = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        localRecorder = new WasapiRecorderBuilder().WithDevice(mic).WithCommunicationsMode()
            .WithEchoCancellationReferenceEndpoint(render).Build();
        localWriter = new WaveFileWriter(localPath!, localRecorder.WaveFormat);
        localRecorder.DataAvailable += (buffer, _, _, _) => OnAudio("local", buffer.ToArray(), localRecorder.WaveFormat);
        remoteRecorder = new WasapiRecorderBuilder().WithDevice(render).WithLoopbackCapture().Build();
        remoteWriter = new WaveFileWriter(remotePath!, remoteRecorder.WaveFormat);
        remoteRecorder.DataAvailable += (buffer, _, _, _) => OnAudio("remote", buffer.ToArray(), remoteRecorder.WaveFormat);
        remoteRecorder.RecordingStopped += (_, e) => { if (e.Exception is not null) StatusChanged?.Invoke("Erro no áudio remoto: " + e.Exception.Message); };
        remoteRecorder.StartRecording(); localRecorder.StartRecording();
    }

    public void UpdateSpeaker(MeetSpeakerRequest request)
    {
        lock (gate)
        {
            var name = CleanName(request.Name);
            if (!string.IsNullOrWhiteSpace(remoteSpeaker) && !string.Equals(remoteSpeaker, name, StringComparison.OrdinalIgnoreCase) && remoteChunk.Active)
                FlushChunkLocked("remote", remoteChunk, request.At);
            if (string.IsNullOrWhiteSpace(name)) { remoteSpeaker = null; remoteSpeakerConfidence = 0; return; }
            remoteSpeaker = name; remoteSpeakerAt = request.At; remoteSpeakerConfidence = Math.Clamp(request.Confidence, 0, 1);
            if (ValidName(name) && !participants.Contains(name, StringComparer.OrdinalIgnoreCase)) participants.Add(name);
        }
    }

    public void UpdateState(MeetStateRequest request)
    {
        lock (gate)
        {
            if (request.Participants is not null)
                foreach (var name in request.Participants.Select(CleanName).Where(ValidName))
                    if (!participants.Contains(name!, StringComparer.OrdinalIgnoreCase)) participants.Add(name!);
        }
        if (!string.IsNullOrWhiteSpace(request.ActiveSpeaker))
            UpdateSpeaker(new MeetSpeakerRequest(request.ActiveSpeaker, DateTimeOffset.Now, request.Confidence));
    }

    private string? ResolveRemoteSpeaker(DateTimeOffset now)
    {
        var cfg = configProvider();
        lock (gate)
        {
            if (!string.IsNullOrWhiteSpace(remoteSpeaker) && remoteSpeakerConfidence >= .55
                && now - remoteSpeakerAt <= TimeSpan.FromSeconds(2.4)
                && !string.Equals(remoteSpeaker, cfg?.OwnerPerson, StringComparison.OrdinalIgnoreCase)) return remoteSpeaker;
            return null;
        }
    }

    private void OnAudio(string role, byte[] bytes, WaveFormat format)
    {
        if (current is null || bytes.Length == 0) return;
        var now = DateTimeOffset.Now;
        var speaker = role == "remote" ? ResolveRemoteSpeaker(now) : configProvider()?.OwnerPerson;
        var activeRemote = role == "local" ? ResolveRemoteSpeaker(now) : null;
        var allowRemote = role != "remote" || !string.IsNullOrWhiteSpace(speaker);
        var durationMs = format.AverageBytesPerSecond > 0 ? bytes.Length * 1000d / format.AverageBytesPerSecond : 0;
        var rms = Rms(bytes, format);
        if (role == "local") lastLocalRms = rms; else lastRemoteRms = rms;
        var chunk = role == "local" ? localChunk : remoteChunk;
        var startThreshold = role == "local" ? (string.IsNullOrWhiteSpace(activeRemote) ? 0.00105 : 0.00220) : 0.00075;
        var continueThreshold = chunk.Active ? startThreshold * 0.72 : startThreshold;
        var voiced = allowRemote && rms >= continueThreshold;
        var payload = role == "remote" && !allowRemote ? new byte[bytes.Length] : bytes;
        lock (gate)
        {
            if (role == "local") localWriter?.Write(payload, 0, payload.Length); else remoteWriter?.Write(payload, 0, payload.Length);
            if (!chunk.Active)
            {
                if (!voiced) return;
                chunk.Reset(now); chunk.Active = true; chunk.Format = format; chunk.StartedAt = now;
            }
            chunk.Format ??= format;
            chunk.Buffer.Write(payload, 0, payload.Length);
            chunk.TotalMs += durationMs; chunk.PeakRms = Math.Max(chunk.PeakRms, rms);
            if (voiced)
            {
                chunk.VoicedMs += durationMs; chunk.SilenceMs = 0; chunk.CurrentVoicedRunMs += durationMs;
                chunk.MaxVoicedRunMs = Math.Max(chunk.MaxVoicedRunMs, chunk.CurrentVoicedRunMs);
                chunk.LastVoicedByte = chunk.Buffer.Length;
                var key = string.IsNullOrWhiteSpace(speaker) ? "Participantes" : speaker!;
                chunk.SpeakerMs[key] = chunk.SpeakerMs.GetValueOrDefault(key) + durationMs;
            }
            else { chunk.CurrentVoicedRunMs = 0; chunk.SilenceMs += durationMs; }
            var minVoiced = role == "local" ? 360 : 240;
            if (chunk.TotalMs >= 5000 || (chunk.VoicedMs >= minVoiced && chunk.SilenceMs >= 520)) FlushChunkLocked(role, chunk, now);
        }
    }

    private void FlushChunkLocked(string role, ChunkState chunk, DateTimeOffset now)
    {
        if (!chunk.Active || chunk.Format is null || chunk.Buffer.Length == 0) { chunk.Reset(now); return; }
        var minVoicedMs = role == "local" ? 360 : 240;
        var minRunMs = role == "local" ? 260 : 160;
        var shouldTranscribe = chunk.VoicedMs >= minVoicedMs && chunk.MaxVoicedRunMs >= minRunMs;
        var raw = chunk.Buffer.ToArray(); var format = chunk.Format; var started = chunk.StartedAt; var ended = now;
        if (shouldTranscribe && chunk.LastVoicedByte > 0)
        {
            var padBytes = (long)Math.Round(format.AverageBytesPerSecond * 0.18);
            var align = Math.Max(1, format.BlockAlign);
            var to = Math.Min(raw.LongLength, chunk.LastVoicedByte + padBytes); to -= to % align;
            if (to > 0 && to < raw.LongLength && to <= int.MaxValue)
            {
                Array.Resize(ref raw, (int)to);
                ended = chunk.StartedAt.AddMilliseconds(to * 1000d / Math.Max(1, format.AverageBytesPerSecond));
            }
        }
        var speaker = role == "local" ? (configProvider()?.OwnerPerson ?? "Colaborador")
            : chunk.SpeakerMs.OrderByDescending(x => x.Value).Select(x => x.Key).FirstOrDefault() ?? "Participantes";
        chunk.Reset(now);
        if (!shouldTranscribe) return;
        var task = TranscribeChunkAsync(role, speaker, raw, format, started, ended);
        pending.Add(task);
        _ = task.ContinueWith(_ => { lock (gate) pending.Remove(task); }, TaskScheduler.Default);
    }

    private async Task TranscribeChunkAsync(string role, string speaker, byte[] raw, WaveFormat format, DateTimeOffset started, DateTimeOffset ended)
    {
        await sttSlots.WaitAsync();
        try
        {
            var cfg = configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
            var wav = BuildWav(raw, format); string text = ""; Exception? lastError = null;
            for (var attempt = 1; attempt <= 4; attempt++)
            {
                try { text = (await new MeetRelatoApi(cfg).TranscribeAudioAsync(wav)).Trim(); lastError = null; break; }
                catch (Exception ex) { lastError = ex; if (attempt < 4) await Task.Delay(TimeSpan.FromMilliseconds(350 * Math.Pow(2, attempt - 1))); }
            }
            if (lastError is not null) throw lastError;
            if (string.IsNullOrWhiteSpace(text) || current is null) return;
            var startMs = Math.Max(0, (int)Math.Round((started - current.StartedAt).TotalMilliseconds));
            var endMs = Math.Max(startMs + 1, (int)Math.Round((ended - current.StartedAt).TotalMilliseconds));
            lock (gate)
            {
                var duplicate = segments.LastOrDefault();
                if (duplicate is not null && duplicate.SpeakerName.Equals(speaker, StringComparison.OrdinalIgnoreCase)
                    && duplicate.Text.Equals(text, StringComparison.OrdinalIgnoreCase) && startMs - duplicate.EndedMs < 6000) return;
                segments.Add(new MeetLiveSegment(Interlocked.Increment(ref segmentSeq), speaker, text, startMs, endMs, role));
            }
        }
        catch (Exception ex) { StatusChanged?.Invoke("STT Meet: " + ex.Message); }
        finally { sttSlots.Release(); }
    }

    private static byte[] BuildWav(byte[] raw, WaveFormat format)
    {
        using var ms = new MemoryStream();
        using (var writer = new WaveFileWriter(ms, format)) { writer.Write(raw, 0, raw.Length); writer.Flush(); }
        return ms.ToArray();
    }

    private static double Rms(byte[] data, WaveFormat format)
    {
        if (data.Length == 0) return 0;
        try
        {
            if (format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
            {
                var n = data.Length / 4; if (n == 0) return 0; double sum = 0;
                for (var i = 0; i < n; i++) { var v = BitConverter.ToSingle(data, i * 4); if (!float.IsFinite(v)) continue; sum += v * v; }
                return Math.Sqrt(sum / n);
            }
            if (format.BitsPerSample == 16)
            {
                var n = data.Length / 2; if (n == 0) return 0; double sum = 0;
                for (var i = 0; i < n; i++) { var v = BitConverter.ToInt16(data, i * 2) / 32768.0; sum += v * v; }
                return Math.Sqrt(sum / n);
            }
        }
        catch { }
        return data.Count(b => b != 0) / (double)data.Length;
    }

    public IReadOnlyList<MeetLiveSegment> GetLive(long afterSeq)
    {
        lock (gate) return segments.Where(x => x.Seq > afterSeq).OrderBy(x => x.Seq).ToArray();
    }

    public MeetHealth GetHealth()
    {
        lock (gate) return new MeetHealth(current is not null, current?.LocalSessionId, segments.Count, remoteSpeaker, pending.Count, lastLocalRms, lastRemoteRms);
    }

    public async Task FinishAsync(string reason)
    {
        MeetStartRequest? closing; lock (gate) closing = current; if (closing is null) return;
        StopRecorders();
        lock (gate) { FlushChunkLocked("local", localChunk, DateTimeOffset.Now); FlushChunkLocked("remote", remoteChunk, DateTimeOffset.Now); }
        Task[] jobs; lock (gate) jobs = pending.ToArray();
        if (jobs.Length > 0) { try { await Task.WhenAll(jobs).WaitAsync(TimeSpan.FromSeconds(45)); } catch (TimeoutException) { } }
        IReadOnlyList<MeetLiveSegment> finalSegments; IReadOnlyList<string> finalParticipants;
        lock (gate) { finalSegments = segments.OrderBy(x => x.StartedMs).ThenBy(x => x.Seq).ToArray(); finalParticipants = participants.Distinct(StringComparer.OrdinalIgnoreCase).ToArray(); }
        var success = false; string? error = null;
        try
        {
            var cfg = configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
            await new MeetRelatoApi(cfg).FinalizeMeetingAsync(closing, DateTimeOffset.Now, reason, finalSegments, finalParticipants);
            success = true; StatusChanged?.Invoke("Meet enviado ao Relato AI");
        }
        catch (Exception ex) { error = ex.Message; StatusChanged?.Invoke("Falha ao finalizar Meet: " + ex.Message); }
        finally
        {
            lock (gate) current = null;
            MeetingFinished?.Invoke(closing.LocalSessionId, success, error);
            if (success) CleanupFiles(localPath, remotePath);
            localPath = null; remotePath = null;
        }
    }

    private void StopRecorders()
    {
        try { remoteRecorder?.StopRecording(); } catch { } try { localRecorder?.StopRecording(); } catch { }
        remoteRecorder?.Dispose(); remoteRecorder = null; localRecorder?.Dispose(); localRecorder = null;
        lock (gate) { remoteWriter?.Dispose(); remoteWriter = null; localWriter?.Dispose(); localWriter = null; }
    }

    private static string? CleanName(string? value)
    {
        var text = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();
        return text.Length > 160 ? text[..160] : text;
    }

    private static bool ValidName(string? value)
    {
        var name = CleanName(value);
        return !string.IsNullOrWhiteSpace(name) && name.Length >= 2
            && !name.Equals("Participantes", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("Participante", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("Você", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("You", StringComparison.OrdinalIgnoreCase);
    }

    private static void CleanupFiles(params string?[] paths)
    {
        foreach (var path in paths) try { if (!string.IsNullOrWhiteSpace(path) && File.Exists(path)) File.Delete(path); } catch { }
    }

    public void Dispose()
    {
        if (disposed) return; disposed = true;
        try { if (current is not null) FinishAsync("agent_exit").GetAwaiter().GetResult(); } catch { }
        StopRecorders(); sttSlots.Dispose();
    }
}
