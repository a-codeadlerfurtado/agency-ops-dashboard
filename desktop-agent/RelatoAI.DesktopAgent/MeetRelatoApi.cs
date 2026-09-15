using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed class MeetRelatoApi
{
    private const string CaptureApi = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meeting-capture-api";
    private const string SttApi = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/jarvis/stt";
    private readonly AgentConfig config;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(3) };

    public MeetRelatoApi(AgentConfig config) => this.config = config;

    private async Task<JsonDocument> PostCaptureAsync(object payload)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, CaptureApi) { Content = JsonContent.Create(payload) };
        req.Headers.Add("x-meeting-device-token", config.Token);
        using var res = await http.SendAsync(req);
        var raw = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"Relato API {(int)res.StatusCode}: {raw[..Math.Min(raw.Length, 500)]}");
        return JsonDocument.Parse(raw);
    }

    public async Task HeartbeatMeetingAsync(MeetStartRequest meeting, string state, object? metadata = null)
    {
        using var _ = await PostCaptureAsync(new
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
                native_transcript_available = false,
                captions_available = false,
                extension_version = "desktop-0.5.0",
                metadata = metadata ?? new { recorder = "DESKTOP_AGENT" }
            }
        });
    }

    public async Task<string> TranscribeAudioAsync(byte[] wav)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, SttApi);
        req.Headers.Add("x-meeting-device-token", config.Token);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        req.Content = new ByteArrayContent(wav);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        using var res = await http.SendAsync(req);
        var raw = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"STT {(int)res.StatusCode}: {raw[..Math.Min(raw.Length, 500)]}");
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.TryGetProperty("text", out var text) ? text.GetString() ?? "" : "";
    }

    public async Task FinalizeMeetingAsync(
        MeetStartRequest meeting, DateTimeOffset endedAt, string reason,
        IReadOnlyList<MeetLiveSegment> segments, IReadOnlyList<string> participants)
    {
        if (segments.Count == 0)
        {
            await HeartbeatMeetingAsync(meeting, "NEEDS_REVIEW", new { recorder = "DESKTOP_AGENT", finish_reason = reason, last_error = "no_desktop_segments" });
            return;
        }
        var ordered = segments.OrderBy(x => x.StartedMs).ThenBy(x => x.Seq).ToArray();
        var participantRows = participants
            .Append(config.OwnerPerson)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(name => new
            {
                participant_key = "desktop:" + name.Trim().ToLowerInvariant(),
                display_name = name.Trim(),
                source = "MEET_DESKTOP_AGENT",
                identity_confidence = string.Equals(name.Trim(), config.OwnerPerson, StringComparison.OrdinalIgnoreCase) ? 1.0 : 0.9
            }).ToArray();
        var segmentRows = ordered.Select((row, index) => new
        {
            sequence_no = index,
            started_ms = Math.Max(0, row.StartedMs),
            ended_ms = Math.Max(row.StartedMs + 1, row.EndedMs),
            speaker_key = "desktop:" + row.SpeakerName.Trim().ToLowerInvariant(),
            speaker_name = row.SpeakerName,
            text = row.Text,
            confidence = (double?)null,
            source = "MEET_DESKTOP_WHISPER"
        }).ToArray();
        using var _ = await PostCaptureAsync(new
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
                extension_version = "desktop-0.5.0",
                metadata = new { recorder = "DESKTOP_AGENT", finish_reason = reason, local_remote_split = true, speaker_context = "MEET_EXTENSION" }
            },
            participants = participantRows,
            segments = segmentRows
        });
    }
}
