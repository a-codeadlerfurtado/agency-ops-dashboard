using System.Net.Http.Json;
using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed record PairResult(string DeviceToken, string DeviceId, string OwnerPerson);
internal sealed record UploadTarget(string Role, string Path, string SignedUrl);
internal sealed record PreparedCall(string SessionId, IReadOnlyList<UploadTarget> Uploads);

internal sealed class RelatoApi
{
    private const string Endpoint =
        "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meeting-capture-api";
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(3) };
    private readonly AgentConfig? config;

    public RelatoApi(AgentConfig? config = null) => this.config = config;

    private HttpRequestMessage Request(object payload, bool withToken = true)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = JsonContent.Create(payload)
        };
        if (withToken && config is not null)
            req.Headers.Add("x-meeting-device-token", config.Token);
        return req;
    }

    private async Task<JsonDocument> SendAsync(object payload, bool withToken = true)
    {
        using var req = Request(payload, withToken);
        using var res = await http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"Relato API {res.StatusCode}: {text[..Math.Min(text.Length, 500)]}");
        return JsonDocument.Parse(text);
    }

    public async Task<PairResult> PairAsync(string code)
    {
        using var doc = await SendAsync(new
        {
            action = "pair_redeem",
            code = code.Trim().ToUpperInvariant(),
            device_name = Environment.MachineName + " · Relato AI Desktop Agent",
            extension_version = "desktop-0.1.0"
        }, withToken: false);
        var root = doc.RootElement;
        return new PairResult(
            root.GetProperty("device_token").GetString() ?? "",
            root.GetProperty("device_id").GetString() ?? "",
            root.GetProperty("owner_person").GetString() ?? "");
    }

    public async Task<PreparedCall> PrepareCallAsync(
        string localSessionId, DateTimeOffset started, DateTimeOffset ended,
        string contactName, IReadOnlyList<string> roles)
    {
        using var doc = await SendAsync(new
        {
            action = "call_prepare",
            call = new
            {
                local_session_id = localSessionId,
                started_at = started.UtcDateTime.ToString("O"),
                ended_at = ended.UtcDateTime.ToString("O"),
                contact_name = contactName,
                finish_reason = "desktop_audio_session_ended",
                extension_version = "desktop-0.1.0",
                source = "WHATSAPP_DESKTOP",
                audio_ext = "wav"
            },
            roles
        });
        var root = doc.RootElement;
        var uploads = new List<UploadTarget>();
        foreach (var item in root.GetProperty("uploads").EnumerateArray())
            uploads.Add(new UploadTarget(
                item.GetProperty("role").GetString() ?? "",
                item.GetProperty("path").GetString() ?? "",
                item.GetProperty("signed_url").GetString() ?? ""));
        return new PreparedCall(root.GetProperty("session_id").GetString() ?? "", uploads);
    }

    public async Task UploadAsync(string signedUrl, string filePath)
    {
        using var fs = File.OpenRead(filePath);
        using var req = new HttpRequestMessage(HttpMethod.Put, signedUrl)
        {
            Content = new StreamContent(fs)
        };
        req.Content.Headers.ContentType = new("audio/wav");
        req.Headers.TryAddWithoutValidation("x-upsert", "true");
        using var res = await http.SendAsync(req);
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"Upload falhou: {(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
    }

    public async Task FinalizeCallAsync(string localSessionId, IEnumerable<object> uploaded)
    {
        using var _ = await SendAsync(new
        {
            action = "call_finalize",
            local_session_id = localSessionId,
            uploaded = uploaded.ToArray()
        });
    }

    public async Task SaveFeedbackAsync(string localSessionId, object feedback)
    {
        using var _ = await SendAsync(new
        {
            action = "human_feedback_save",
            feedback = MergeFeedback(localSessionId, feedback)
        });
    }

    private static Dictionary<string, object?> MergeFeedback(string sessionId, object feedback)
    {
        var json = JsonSerializer.SerializeToElement(feedback);
        var map = json.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone());
        map["local_session_id"] = sessionId;
        map["channel"] = "WHATSAPP_DESKTOP_CALL";
        return map;
    }
}
