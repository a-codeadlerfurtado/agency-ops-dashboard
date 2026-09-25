using System.Collections.Concurrent;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace RelatoAI.DesktopAgent;

internal sealed record MeetStartRequest(
    string LocalSessionId, string MeetingCode, string MeetingUrl, string Title,
    DateTimeOffset StartedAt, IReadOnlyList<string>? Participants = null);
internal sealed record MeetSpeakerRequest(string? Name, DateTimeOffset At, double Confidence = 1);
internal sealed record MeetStateRequest(IReadOnlyList<string>? Participants = null, string? ActiveSpeaker = null, double Confidence = 1);
internal sealed record MeetLiveSegment(long Seq, string SpeakerName, string Text, int StartedMs, int EndedMs, string Role);
internal sealed record MeetHealth(bool Recording, string? SessionId, int Segments, string? RemoteSpeaker, int PendingTranscriptions);

internal sealed class MeetDesktopCapture : IDisposable
{
    private sealed class ChunkState
    {
        public MemoryStream Buffer { get; } = new();
        public WaveFormat? Format { get; set; }
        public DateTimeOffset StartedAt { get; set; }
        public double TotalMs { get; set; }
        public double VoicedMs { get; set; }
        public double CurrentVoicedRunMs { get; set; }
        public double MaxVoicedRunMs { get; set; }
        public double PeakRms { get; set; }
        public long FirstVoicedByte { get; set; } = -1;
        public long LastVoicedByte { get; set; } = -1;
        public Dictionary<string, double> SpeakerMs { get; } = new(StringComparer.OrdinalIgnoreCase);
        public void Reset(DateTimeOffset now) { Buffer.SetLength(0); StartedAt = now; TotalMs = 0; VoicedMs = 0; CurrentVoicedRunMs = 0; MaxVoicedRunMs = 0; PeakRms = 0; FirstVoicedByte = -1; LastVoicedByte = -1; SpeakerMs.Clear(); }
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
    private MeetingAudioOutboxItem? audioOutbox;
    private readonly System.Threading.Timer retryTimer;
    private int retrying;
    private bool disposed;

    public event Action<string>? StatusChanged;
    public event Action<string>? MeetingStarted;
    public event Action<string, bool, string?>? MeetingFinished;
    public bool IsRecording => current is not null;

    public MeetDesktopCapture(Func<AgentConfig?> configProvider)
    {
        this.configProvider = configProvider;
        retryTimer = new System.Threading.Timer(_ => RetryOutboxSafe(), null, TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1));
    }

    public async Task StartAsync(MeetStartRequest request)
    {
        if (disposed) throw new ObjectDisposedException(nameof(MeetDesktopCapture));
        if (current is not null) await FinishAsync("replaced_by_new_meeting");
        var cfg = configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
        current = request;
        segmentSeq = 0;
        lock (gate)
        {
            segments.Clear(); participants.Clear();
            if (request.Participants is not null) participants.AddRange(request.Participants.Where(ValidName).Distinct(StringComparer.OrdinalIgnoreCase));
            localChunk.Reset(request.StartedAt); remoteChunk.Reset(request.StartedAt);
            remoteSpeaker = null; remoteSpeakerAt = DateTimeOffset.MinValue; remoteSpeakerConfidence = 0;
        }
        audioOutbox = MeetingAudioOutbox.Create(request);
        localPath = audioOutbox.LocalPath;
        remotePath = audioOutbox.RemotePath;
        await StartRecordersAsync();
        MeetingStarted?.Invoke(request.MeetingCode);
        StatusChanged?.Invoke($"REC · Google Meet · {request.MeetingCode} · Desktop Agent");
        _ = new RelatoApi(cfg).HeartbeatMeetingAsync(request, "CAPTURING", new { recorder = "DESKTOP_AGENT", roles = new[] { "local", "remote" } });
    }

    private async Task StartRecordersAsync()
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
        remoteRecorder.StartRecording();
        localRecorder.StartRecording();
        await Task.CompletedTask;
    }

    public void UpdateSpeaker(MeetSpeakerRequest request)
    {
        lock (gate)
        {
            var name = CleanName(request.Name);
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
            {
                foreach (var name in request.Participants.Select(CleanName).Where(ValidName))
                    if (!participants.Contains(name!, StringComparer.OrdinalIgnoreCase)) participants.Add(name!);
            }
        }
        if (!string.IsNullOrWhiteSpace(request.ActiveSpeaker))
            UpdateSpeaker(new MeetSpeakerRequest(request.ActiveSpeaker, DateTimeOffset.Now, request.Confidence));
    }

    private string? ResolveRemoteSpeaker(DateTimeOffset now)
    {
        var cfg = configProvider();
        lock (gate)
        {
            if (!string.IsNullOrWhiteSpace(remoteSpeaker)
                && remoteSpeakerConfidence >= .55
                && now - remoteSpeakerAt <= TimeSpan.FromSeconds(2.2)
                && !string.Equals(remoteSpeaker, cfg?.OwnerPerson, StringComparison.OrdinalIgnoreCase))
                return remoteSpeaker;
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
        var threshold = role == "local" ? (string.IsNullOrWhiteSpace(activeRemote) ? 0.00085 : 0.00220) : 0.00075;
        var rms = AudioLevel.Rms(bytes, format);
        var voiced = allowRemote && rms >= threshold;
        byte[] payload = bytes;
        if (role == "remote" && !allowRemote) payload = new byte[bytes.Length];
        lock (gate)
        {
            if (role == "local") localWriter?.Write(payload, 0, payload.Length);
            else remoteWriter?.Write(payload, 0, payload.Length);
            var chunk = role == "local" ? localChunk : remoteChunk;
            chunk.Format ??= format;
            if (chunk.StartedAt == default) chunk.StartedAt = now;
            var blockStart = chunk.Buffer.Length;
            chunk.Buffer.Write(payload, 0, payload.Length);
            chunk.TotalMs += durationMs;
            chunk.PeakRms = Math.Max(chunk.PeakRms, rms);
            if (voiced) {
                if (chunk.FirstVoicedByte < 0) chunk.FirstVoicedByte = blockStart;
                chunk.LastVoicedByte = chunk.Buffer.Length;
                chunk.VoicedMs += durationMs;
                chunk.CurrentVoicedRunMs += durationMs;
                chunk.MaxVoicedRunMs = Math.Max(chunk.MaxVoicedRunMs, chunk.CurrentVoicedRunMs);
                var key = string.IsNullOrWhiteSpace(speaker) ? "Participantes" : speaker!;
                chunk.SpeakerMs[key] = chunk.SpeakerMs.GetValueOrDefault(key) + durationMs;
            } else chunk.CurrentVoicedRunMs = 0;
            if (chunk.TotalMs >= 3000) FlushChunkLocked(role, chunk, now);
        }
    }

    private void FlushChunkLocked(string role, ChunkState chunk, DateTimeOffset now)
    {
        if (chunk.Format is null || chunk.Buffer.Length == 0) { chunk.Reset(now); return; }
        var total = Math.Max(1, chunk.TotalMs);
        var voicedRatio = chunk.VoicedMs / total;
        var minVoicedMs = role == "local" ? 320 : 240;
        var minRunMs = role == "local" ? 220 : 160;
        var minRatio = role == "local" ? .10 : .08;
        var shouldTranscribe = chunk.VoicedMs >= minVoicedMs && chunk.MaxVoicedRunMs >= minRunMs && voicedRatio >= minRatio;
        var raw = chunk.Buffer.ToArray();
        var format = chunk.Format;
        var started = chunk.StartedAt;
        var ended = now;
        if (shouldTranscribe && chunk.FirstVoicedByte >= 0 && chunk.LastVoicedByte > chunk.FirstVoicedByte)
        {
            var padBytes = (long)Math.Round(format.AverageBytesPerSecond * 0.18);
            var blockAlign = Math.Max(1, format.BlockAlign);
            var from = Math.Max(0, chunk.FirstVoicedByte - padBytes);
            var to = Math.Min(raw.LongLength, chunk.LastVoicedByte + padBytes);
            from -= from % blockAlign;
            to -= to % blockAlign;
            if (to > from && to <= int.MaxValue)
            {
                var trimmed = new byte[(int)(to - from)];
                Buffer.BlockCopy(raw, (int)from, trimmed, 0, trimmed.Length);
                raw = trimmed;
                var msPerByte = 1000d / Math.Max(1, format.AverageBytesPerSecond);
                started = chunk.StartedAt.AddMilliseconds(from * msPerByte);
                ended = chunk.StartedAt.AddMilliseconds(to * msPerByte);
            }
        }
        var speaker = role == "local"
            ? (configProvider()?.OwnerPerson ?? "Colaborador")
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
            var wav = BuildWav(raw, format);
            string text = "";
            Exception? lastError = null;
            for (var attempt = 1; attempt <= 4; attempt++)
            {
                try { text = (await new RelatoApi(cfg).TranscribeAudioAsync(wav)).Trim(); lastError = null; break; }
                catch (Exception ex)
                {
                    lastError = ex;
                    if (attempt < 4) await Task.Delay(TimeSpan.FromMilliseconds(350 * Math.Pow(2, attempt - 1)));
                }
            }
            if (lastError is not null) throw lastError;
            if (string.IsNullOrWhiteSpace(text) || current is null) return;
            var baseStart = current.StartedAt;
            var startMs = Math.Max(0, (int)Math.Round((started - baseStart).TotalMilliseconds));
            var endMs = Math.Max(startMs + 1, (int)Math.Round((ended - baseStart).TotalMilliseconds));
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

    public IReadOnlyList<MeetLiveSegment> GetLive(long afterSeq)
    {
        lock (gate) return segments.Where(x => x.Seq > afterSeq).OrderBy(x => x.Seq).ToArray();
    }

    public MeetHealth GetHealth()
    {
        lock (gate) return new MeetHealth(current is not null, current?.LocalSessionId, segments.Count, remoteSpeaker, pending.Count);
    }

    public async Task FinishAsync(string reason)
    {
        MeetStartRequest? closing;
        lock (gate) closing = current;
        if (closing is null) return;

        var endedAt = DateTimeOffset.Now;
        StopRecorders();
        if (audioOutbox is not null)
            audioOutbox = MeetingAudioOutbox.MarkRecorded(audioOutbox, endedAt);

        lock (gate)
        {
            FlushChunkLocked("local", localChunk, endedAt);
            FlushChunkLocked("remote", remoteChunk, endedAt);
        }
        Task[] jobs; lock (gate) jobs = pending.ToArray();
        if (jobs.Length > 0)
        {
            try { await Task.WhenAll(jobs).WaitAsync(TimeSpan.FromSeconds(45)); }
            catch (TimeoutException) { StatusChanged?.Invoke("STT pendente; preservando áudio para processamento."); }
        }

        IReadOnlyList<MeetLiveSegment> finalSegments;
        IReadOnlyList<string> finalParticipants;
        lock (gate)
        {
            finalSegments = segments.OrderBy(x => x.StartedMs).ThenBy(x => x.Seq).ToArray();
            finalParticipants = participants.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        var transcriptOk = false;
        string? transcriptError = null;
        try
        {
            var cfg = configProvider() ?? throw new InvalidOperationException("Desktop Agent não pareado");
            await new RelatoApi(cfg).FinalizeMeetingAsync(closing, endedAt, reason, finalSegments, finalParticipants);
            transcriptOk = true;
        }
        catch (Exception ex)
        {
            transcriptError = ex.Message;
            StatusChanged?.Invoke("Falha ao finalizar transcrição: " + ex.Message);
        }

        var audioStored = false;
        if (audioOutbox is not null)
        {
            var outboxItem = audioOutbox;
            try
            {
                await UploadAudioItemAsync(outboxItem);
                audioStored = true;
                audioOutbox = null;
            }
            catch (Exception ex)
            {
                audioOutbox = MeetingAudioOutbox.MarkFailed(outboxItem, ex);
                StatusChanged?.Invoke("Gravação aguardando envio: " + ex.Message);
            }
        }

        lock (gate) current = null;
        localPath = null;
        remotePath = null;

        var safe = transcriptOk && (audioStored || audioOutbox is not null);
        var finalError = transcriptOk
            ? (audioStored ? null : "Transcrição salva; gravação aguardando envio automático.")
            : transcriptError;
        StatusChanged?.Invoke(audioStored
            ? (transcriptOk ? "Meet e gravação enviados ao Relato AI" : "Gravação preservada; transcrição precisa de revisão")
            : "Meet finalizado; gravação preservada na fila local");
        MeetingFinished?.Invoke(closing.LocalSessionId, safe, finalError);
    }

    private async Task UploadAudioItemAsync(MeetingAudioOutboxItem item)
    {
        var cfg = configProvider() ?? AgentConfig.Load() ?? throw new InvalidOperationException("Desktop Agent não pareado");
        if (item.EndedAt is null) throw new InvalidOperationException("Gravação ainda não encerrada");
        var endedAt = item.EndedAt.Value;

        var mixedReady = MeetingAudioMixer.TryCreateMixedMp3(item, out var mixError);
        if (!mixedReady && !string.IsNullOrWhiteSpace(mixError))
            StatusChanged?.Invoke("Mix local indisponível; preservando WAVs: " + mixError);

        var files = new List<(string Role, string Ext, string Mime)>();
        if (File.Exists(item.LocalPath) && new FileInfo(item.LocalPath).Length > 1000) files.Add(("local", "wav", "audio/wav"));
        if (File.Exists(item.RemotePath) && new FileInfo(item.RemotePath).Length > 1000) files.Add(("remote", "wav", "audio/wav"));
        if (mixedReady && !string.IsNullOrWhiteSpace(item.MixedPath)
            && File.Exists(item.MixedPath) && new FileInfo(item.MixedPath).Length > 1000)
            files.Add(("mixed", "mp3", "audio/mpeg"));
        if (files.Count == 0) throw new InvalidOperationException("Nenhum áudio preservado para upload");

        item = MeetingAudioOutbox.MarkUploading(item);
        var durationMs = Math.Max(0, (long)Math.Round((endedAt - item.StartedAt).TotalMilliseconds));
        var api = new RelatoApi(cfg);
        var prepared = await api.PrepareMeetingAudioAsync(item.LocalSessionId, durationMs, "DESKTOP_AGENT", files);
        if (prepared.State == "READY" && prepared.Uploads.Count == 0)
        {
            MeetingAudioOutbox.Remove(item);
            return;
        }

        var uploaded = new List<object>();
        foreach (var target in prepared.Uploads)
        {
            string? file = target.Role switch
            {
                "local" => item.LocalPath,
                "remote" => item.RemotePath,
                "mixed" => item.MixedPath,
                _ => null
            };
            if (string.IsNullOrWhiteSpace(file) || !File.Exists(file)) continue;
            var mime = target.Role == "mixed" ? "audio/mpeg" : "audio/wav";
            await api.UploadAsync(target.SignedUrl, file, mime);
            uploaded.Add(new
            {
                role = target.Role,
                path = target.Path,
                bytes = new FileInfo(file).Length,
                mime_type = mime
            });
        }
        if (uploaded.Count == 0) throw new InvalidOperationException("Nenhum áudio enviado");
        await api.FinalizeMeetingAudioAsync(item.LocalSessionId, uploaded, durationMs);
        MeetingAudioOutbox.Remove(item);
    }

    private void RetryOutboxSafe()
    {
        if (disposed || Interlocked.Exchange(ref retrying, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                if (configProvider() is null && AgentConfig.Load() is null) return;
                foreach (var item in MeetingAudioOutbox.LoadPending().Where(x => x.EndedAt is not null && x.State != "RECORDING"))
                {
                    try
                    {
                        await UploadAudioItemAsync(item);
                        StatusChanged?.Invoke("Gravação pendente enviada ao Relato AI");
                    }
                    catch (Exception ex)
                    {
                        MeetingAudioOutbox.MarkFailed(item, ex);
                    }
                }
            }
            finally
            {
                Volatile.Write(ref retrying, 0);
            }
        });
    }

    private void StopRecorders()
    {
        try { remoteRecorder?.StopRecording(); } catch { }
        try { localRecorder?.StopRecording(); } catch { }
        remoteRecorder?.Dispose(); remoteRecorder = null;
        localRecorder?.Dispose(); localRecorder = null;
        lock (gate)
        {
            remoteWriter?.Dispose(); remoteWriter = null;
            localWriter?.Dispose(); localWriter = null;
        }
    }

    private static string? CleanName(string? value)
    {
        var text = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (text.Length > 160) text = text[..160];
        return text;
    }

    private static bool ValidName(string? value)
    {
        var name = CleanName(value);
        return !string.IsNullOrWhiteSpace(name)
            && name.Length >= 2
            && !name.Equals("Participantes", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("Participante", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("Você", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("You", StringComparison.OrdinalIgnoreCase);
    }

    private static void CleanupFiles(params string?[] paths)
    {
        foreach (var path in paths)
        {
            try { if (!string.IsNullOrWhiteSpace(path) && File.Exists(path)) File.Delete(path); } catch { }
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        retryTimer.Dispose();
        try { if (current is not null) FinishAsync("agent_exit").GetAwaiter().GetResult(); } catch { }
        StopRecorders();
        sttSlots.Dispose();
    }
}
