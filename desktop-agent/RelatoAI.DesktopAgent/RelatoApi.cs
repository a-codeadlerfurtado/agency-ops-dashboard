using System.Net.Http.Json;
using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed record PairResult(string DeviceToken, string DeviceId, string OwnerPerson);
internal sealed record UploadTarget(string Role, string Path, string SignedUrl);
internal sealed record PreparedCall(string SessionId, IReadOnlyList<UploadTarget> Uploads);
internal sealed record PreparedMeetingAudio(string SessionId, IReadOnlyList<UploadTarget> Uploads, string State);
internal sealed record ClientOption(string Id, string Name);
internal sealed record FeedbackContext(
    bool Pending, bool RequiresSelection, string? RemotePhone, string? RemoteName, string? RemoteRole,
    string? ClientId, string? ClientName, string? ResolutionStatus, IReadOnlyList<ClientOption> Clients);

internal sealed partial class RelatoApi
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
        string contactName, IReadOnlyList<string> roles,
        string? localPhone = null, string? remotePhone = null, string? identitySource = null)
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
                local_phone = localPhone,
                remote_phone = remotePhone,
                identity_source = identitySource,
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

    public async Task<FeedbackContext> GetFeedbackContextAsync(string localSessionId)
    {
        using var doc = await SendAsync(new { action = "call_feedback_context", local_session_id = localSessionId });
        var root = doc.RootElement;
        if (root.TryGetProperty("pending", out var pendingEl) && pendingEl.GetBoolean())
            return new FeedbackContext(true, false, null, null, null, null, null, null, Array.Empty<ClientOption>());
        var clients = new List<ClientOption>();
        if (root.TryGetProperty("clients", out var clientEl) && clientEl.ValueKind == JsonValueKind.Array)
            foreach (var item in clientEl.EnumerateArray())
                clients.Add(new ClientOption(item.GetProperty("id").GetString() ?? "", item.GetProperty("name").GetString() ?? ""));
        string? Read(string name) => root.TryGetProperty(name, out var el) && el.ValueKind != JsonValueKind.Null ? el.GetString() : null;
        return new FeedbackContext(
            false, root.GetProperty("requires_selection").GetBoolean(),
            Read("remote_phone"), Read("remote_name"), Read("remote_role"),
            Read("client_id"), Read("client_name"), Read("resolution_status"), clients);
    }

    public async Task UploadAsync(string signedUrl, string filePath, string mimeType = "audio/wav")
    {
        using var fs = File.OpenRead(filePath);
        using var req = new HttpRequestMessage(HttpMethod.Put, signedUrl)
        {
            Content = new StreamContent(fs)
        };
        req.Content.Headers.ContentType = new(mimeType);
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
