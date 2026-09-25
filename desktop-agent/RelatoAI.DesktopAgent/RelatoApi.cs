using System.Net.Http.Json;
using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed record PairResult(string DeviceToken, string DeviceId, string OwnerPerson);
internal sealed record UploadTarget(string Role, string Path, string SignedUrl);
internal sealed record PreparedCall(string SessionId, IReadOnlyList<UploadTarget> Uploads);
internal sealed record PreparedMeetingAudio(string SessionId, IReadOnlyList<UploadTarget> Uploads, string State);
internal sealed record ClientOption(string Id, string Name);
internal sealed record ProspectPrefill(
    string? Name, string? Company, string? Email, string? Phone, string? City, string? Instagram,
    string? MarketingInvestment, int? BrokerCount, IReadOnlyList<string> PainPoints,
    IReadOnlyList<string> Goals, IReadOnlyList<string> ServicesInterest, IReadOnlyList<string> Objections,
    string? Urgency, string? DecisionRole, string? CurrentStructure,
    IReadOnlyList<string> BuyingSignals, IReadOnlyList<string> ClosingRisks,
    string? CloserBriefing, string? AiSummary, string? NextStep, string? NextStepAt);
internal sealed record FeedbackContext(
    bool Pending, bool RequiresSelection, string? RemotePhone, string? RemoteName, string? RemoteRole,
    string? ClientId, string? ClientName, string? ResolutionStatus, IReadOnlyList<ClientOption> Clients,
    string Workflow, bool TranscriptReady, bool CommercialAnalysisReady, ProspectPrefill? ProspectPrefill);
internal sealed record AgentUpdateInfo(
    bool UpdateRequired, string CurrentVersion, string RequiredVersion,
    string DownloadUrl, string Sha256);

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

    public async Task<AgentUpdateInfo> GetUpdateInfoAsync(string currentVersion)
    {
        using var doc = await SendAsync(new
        {
            action = "agent_update_check",
            current_version = currentVersion
        });
        var root = doc.RootElement;
        string Read(string name) => root.TryGetProperty(name, out var el) && el.ValueKind != JsonValueKind.Null
            ? el.GetString() ?? ""
            : "";
        return new AgentUpdateInfo(
            root.TryGetProperty("update_required", out var updateEl) && updateEl.GetBoolean(),
            Read("current_version"),
            Read("required_version"),
            Read("download_url"),
            Read("sha256"));
    }

    public async Task<PairResult> PairAsync(string code)
    {
        using var doc = await SendAsync(new
        {
            action = "pair_redeem",
            code = code.Trim().ToUpperInvariant(),
            device_name = Environment.MachineName + " · Relato AI Desktop Agent",
            extension_version = "desktop-0.5.0"
        }, withToken: false);
        var root = doc.RootElement;
        return new PairResult(
            root.GetProperty("device_token").GetString() ?? "",
            root.GetProperty("device_id").GetString() ?? "",
            root.GetProperty("owner_person").GetString() ?? "");
    }

    public async Task<PreparedCall> PrepareCallAsync(
        string localSessionId, DateTimeOffset started, DateTimeOffset ended,
        string contactName, IReadOnlyList<string> roles, long durationMs,
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
                duration_ms = durationMs,
                finish_reason = "desktop_audio_session_ended",
                extension_version = "desktop-0.5.0",
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
            return new FeedbackContext(true, false, null, null, null, null, null, null, Array.Empty<ClientOption>(), "PENDING", false, false, null);
        var clients = new List<ClientOption>();
        if (root.TryGetProperty("clients", out var clientEl) && clientEl.ValueKind == JsonValueKind.Array)
            foreach (var item in clientEl.EnumerateArray())
                clients.Add(new ClientOption(item.GetProperty("id").GetString() ?? "", item.GetProperty("name").GetString() ?? ""));
        string? Read(string name) => root.TryGetProperty(name, out var el) && el.ValueKind != JsonValueKind.Null ? el.GetString() : null;
        string? ReadFrom(JsonElement parent, string name) => parent.TryGetProperty(name, out var el) && el.ValueKind != JsonValueKind.Null ? el.GetString() : null;
        string[] ReadArray(JsonElement parent, string name)
        {
            if (!parent.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Array) return [];
            return el.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
                .Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray();
        }

        ProspectPrefill? prefill = null;
        if (root.TryGetProperty("prospect_prefill", out var p) && p.ValueKind == JsonValueKind.Object)
        {
            int? brokerCount = null;
            if (p.TryGetProperty("broker_count", out var brokerEl) && brokerEl.ValueKind == JsonValueKind.Number && brokerEl.TryGetInt32(out var brokerValue))
                brokerCount = brokerValue;
            prefill = new ProspectPrefill(
                ReadFrom(p, "name"), ReadFrom(p, "company"), ReadFrom(p, "email"), ReadFrom(p, "phone"),
                ReadFrom(p, "city"), ReadFrom(p, "instagram"), ReadFrom(p, "marketing_investment"), brokerCount,
                ReadArray(p, "pain_points"), ReadArray(p, "goals"), ReadArray(p, "services_interest"), ReadArray(p, "objections"),
                ReadFrom(p, "urgency"), ReadFrom(p, "decision_role"), ReadFrom(p, "current_structure"),
                ReadArray(p, "buying_signals"), ReadArray(p, "closing_risks"),
                ReadFrom(p, "closer_briefing"), ReadFrom(p, "ai_summary"),
                ReadFrom(p, "next_step"), ReadFrom(p, "next_step_at"));
        }

        var transcriptReady = root.TryGetProperty("transcript_ready", out var tr)
            && (tr.ValueKind is JsonValueKind.True or JsonValueKind.False)
            && tr.GetBoolean();
        var commercialAnalysisReady = root.TryGetProperty("commercial_analysis_ready", out var ar)
            && (ar.ValueKind is JsonValueKind.True or JsonValueKind.False)
            && ar.GetBoolean();
        return new FeedbackContext(
            false, root.GetProperty("requires_selection").GetBoolean(),
            Read("remote_phone"), Read("remote_name"), Read("remote_role"),
            Read("client_id"), Read("client_name"), Read("resolution_status"), clients,
            Read("workflow") ?? "CLIENT_REVIEW", transcriptReady, commercialAnalysisReady, prefill);
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

    public async Task MarkMixedAudioReadyAsync(string localSessionId, string path, long bytes, long durationMs)
    {
        using var _ = await SendAsync(new
        {
            action = "call_mixed_ready",
            local_session_id = localSessionId,
            path,
            bytes,
            duration_ms = durationMs
        });
    }

    public async Task FinalizeCallAsync(string localSessionId, IEnumerable<object> uploaded, long durationMs)
    {
        using var _ = await SendAsync(new
        {
            action = "call_finalize",
            local_session_id = localSessionId,
            uploaded = uploaded.ToArray(),
            duration_ms = durationMs
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
        return map;
    }
}
