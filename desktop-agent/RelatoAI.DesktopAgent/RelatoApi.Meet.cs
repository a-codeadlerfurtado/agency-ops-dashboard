using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed partial class RelatoApi
{
    private const string SttEndpoint =
        "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/jarvis/stt";
    private const string DesktopVersion = "desktop-0.4.6";

    public async Task<string> TranscribeAudioAsync(byte[] wavBytes)
    {
        if (config is null) throw new InvalidOperationException("Desktop Agent não pareado");
        using var req = new HttpRequestMessage(HttpMethod.Post, SttEndpoint);
        req.Headers.Add("x-meeting-device-token", config.Token);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        req.Content = new ByteArrayContent(wavBytes);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        using var res = await http.SendAsync(req);
        var raw = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"STT {(int)res.StatusCode}: {raw[..Math.Min(raw.Length, 300)]}");
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.TryGetProperty("text", out var text) ? text.GetString() ?? "" : "";
    }
    public async Task HeartbeatMeetingAsync(MeetStartRequest meeting, string state, object? metadata = null)
    {
        using var _ = await SendAsync(new
        {
            action = "session_heartbeat",
            session = new
            {
                local_session_id = meeting.LocalSessionId,
                meeting_code = meeting.MeetingCode,
                meeting_url = meeting.MeetingUrl,
                title = meeting.Title,
                started_at = meeting.StartedAt.UtcDateTime.ToString("O"),
                state,
                capture_mode = "MEET_DESKTOP_AGENT_AUDIO",
                captions_available = false,
                extension_version = DesktopVersion,
                metadata
            }
        });
    }

    public async Task FinalizeMeetingAsync(
        MeetStartRequest meeting, DateTimeOffset endedAt, string reason,
        IReadOnlyList<MeetLiveSegment> segments, IReadOnlyList<string> participants)
    {
        if (segments.Count == 0)
        {
            using var _ = await SendAsync(new
            {
                action = "session_heartbeat",
                session = new
                {
                    local_session_id = meeting.LocalSessionId,
                    meeting_code = meeting.MeetingCode,
                    meeting_url = meeting.MeetingUrl,
                    title = meeting.Title,
                    started_at = meeting.StartedAt.UtcDateTime.ToString("O"),
                    ended_at = endedAt.UtcDateTime.ToString("O"),
                    state = "NEEDS_REVIEW",
                    capture_mode = "MEET_DESKTOP_AGENT_AUDIO",
                    captions_available = false,
                    extension_version = DesktopVersion,
                    last_error = "no_desktop_segments",
                    metadata = new { finish_reason = reason, recorder = "DESKTOP_AGENT", no_segments = true }
                }
            });
            return;
        }

        var rows = segments.Select(s => new
        {
            message_id = $"desktop:{s.Seq}",
            message_version = 0,
            device_key = $"desktop:{s.Role}:{Slug(s.SpeakerName)}",
            speaker_name = s.SpeakerName,
            text = s.Text,
            offset_ms = s.StartedMs,
            ended_ms = s.EndedMs,
            source = "MEET_DESKTOP_AGENT_STT",
            role = s.Role
        }).ToArray();
        using var __ = await SendAsync(new
        {
            action = "finalize",
            meeting = new
            {
                local_session_id = meeting.LocalSessionId,
                meeting_code = meeting.MeetingCode,
                meeting_url = meeting.MeetingUrl,
                title = meeting.Title,
                started_at = meeting.StartedAt.UtcDateTime.ToString("O"),
                ended_at = endedAt.UtcDateTime.ToString("O"),
                capture_mode = "MEET_DESKTOP_AGENT_AUDIO",
                native_transcript_available = false,
                captions_available = false,
                extension_version = DesktopVersion,
                metadata = new { finish_reason = reason, recorder = "DESKTOP_AGENT", roles = new[] { "local", "remote" } }
            },
            segments = rows,
            participants = participants.Select(name => new
            {
                participant_key = $"desktop:{Slug(name)}",
                display_name = name,
                source = "DESKTOP_AGENT"
            }).ToArray()
        });
    }

    public async Task<PreparedMeetingAudio> PrepareMeetingAudioAsync(
        string localSessionId, long durationMs, string audioSource, IReadOnlyList<(string Role, string Ext, string Mime)> files)
    {
        using var doc = await SendAsync(new
        {
            action = "meeting_audio_prepare",
            audio = new
            {
                local_session_id = localSessionId,
                duration_ms = durationMs,
                audio_source = audioSource
            },
            files = files.Select(file => new { role = file.Role, ext = file.Ext, mime_type = file.Mime }).ToArray()
        });
        var root = doc.RootElement;
        var uploads = new List<UploadTarget>();
        if (root.TryGetProperty("uploads", out var uploadRows) && uploadRows.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in uploadRows.EnumerateArray())
                uploads.Add(new UploadTarget(
                    item.GetProperty("role").GetString() ?? "",
                    item.GetProperty("path").GetString() ?? "",
                    item.GetProperty("signed_url").GetString() ?? ""));
        }
        var state = root.TryGetProperty("state", out var stateEl) ? stateEl.GetString() ?? "" : "";
        return new PreparedMeetingAudio(root.GetProperty("session_id").GetString() ?? "", uploads, state);
    }

    public async Task FinalizeMeetingAudioAsync(string localSessionId, IEnumerable<object> uploaded, long durationMs)
    {
        using var _ = await SendAsync(new
        {
            action = "meeting_audio_finalize",
            local_session_id = localSessionId,
            uploaded = uploaded.ToArray(),
            duration_ms = durationMs
        });
    }
    private static string Slug(string value)
    {
        var chars = value.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray();
        return new string(chars).Trim('-');
    }
}
