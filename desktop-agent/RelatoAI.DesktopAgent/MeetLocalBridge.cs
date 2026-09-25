using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RelatoAI.DesktopAgent;

internal sealed class MeetLocalBridge : IDisposable
{
    private readonly MeetDesktopCapture capture;
    private readonly TcpListener listener = new(IPAddress.Loopback, 17654);
    private readonly CancellationTokenSource cts = new();
    private readonly JsonSerializerOptions json = new() { PropertyNameCaseInsensitive = true };
    private Task? loop;

    public MeetLocalBridge(MeetDesktopCapture capture) => this.capture = capture;

    public void Start()
    {
        listener.Start();
        loop = Task.Run(AcceptLoopAsync);
    }

    private async Task AcceptLoopAsync()
    {
        while (!cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await listener.AcceptTcpClientAsync(cts.Token); }
            catch (OperationCanceledException) { break; }
            catch { if (cts.IsCancellationRequested) break; else continue; }
            _ = Task.Run(() => HandleAsync(client));
        }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using (client)
        using (var stream = client.GetStream())
        {
            try
            {
                var request = await ReadRequestAsync(stream, cts.Token);
                if (request is null) { await WriteJsonAsync(stream, 400, new { error = "bad_request" }); return; }
                if (request.Method == "OPTIONS") { await WriteJsonAsync(stream, 200, new { ok = true }); return; }
                var path = request.Path.Split('?', 2)[0];
                if (request.Method == "GET" && path == "/health")
                {
                    await WriteJsonAsync(stream, 200, new { ok = true, capture = capture.GetHealth() }); return;
                }
                if (request.Method == "POST" && path == "/meet/start")
                {
                    var body = JsonSerializer.Deserialize<StartDto>(request.Body, json) ?? throw new InvalidOperationException("invalid_start_body");
                    await capture.StartAsync(body.ToRequest());
                    await WriteJsonAsync(stream, 200, new { ok = true, session_id = body.LocalSessionId }); return;
                }
                if (request.Method == "POST" && path == "/meet/speaker")
                {
                    var body = JsonSerializer.Deserialize<SpeakerDto>(request.Body, json) ?? new SpeakerDto();
                    capture.UpdateSpeaker(new MeetSpeakerRequest(body.Name, DateTimeOffset.Now, body.Confidence));
                    await WriteJsonAsync(stream, 200, new { ok = true }); return;
                }

                if (request.Method == "POST" && path == "/meet/state")
                {
                    var body = JsonSerializer.Deserialize<StateDto>(request.Body, json) ?? new StateDto();
                    capture.UpdateState(new MeetStateRequest(body.Participants ?? [], body.ActiveSpeaker, body.Confidence));
                    await WriteJsonAsync(stream, 200, new { ok = true }); return;
                }
                if (request.Method == "GET" && path == "/meet/live")
                {
                    var after = ParseQueryLong(request.Path, "after");
                    var rows = capture.GetLive(after);
                    await WriteJsonAsync(stream, 200, new { ok = true, segments = rows }); return;
                }
                if (request.Method == "POST" && path == "/meet/finish")
                {
                    var body = JsonSerializer.Deserialize<FinishDto>(request.Body, json) ?? new FinishDto();
                    await capture.FinishAsync(string.IsNullOrWhiteSpace(body.Reason) ? "extension_finish" : body.Reason!);
                    await WriteJsonAsync(stream, 200, new { ok = true }); return;
                }
                await WriteJsonAsync(stream, 404, new { error = "not_found" });
            }
            catch (Exception ex) { try { await WriteJsonAsync(stream, 500, new { error = ex.Message }); } catch { } }
        }
    }

    private sealed record Request(string Method, string Path, string Body);

    private static async Task<Request?> ReadRequestAsync(NetworkStream stream, CancellationToken ct)
    {
        var buffer = new byte[8192];
        using var ms = new MemoryStream();
        int headerEnd = -1;
        while (headerEnd < 0 && ms.Length < 65536)
        {
            var read = await stream.ReadAsync(buffer, ct);
            if (read <= 0) return null;
            ms.Write(buffer, 0, read);
            headerEnd = FindHeaderEnd(ms.GetBuffer(), (int)ms.Length);
        }
        if (headerEnd < 0) return null;
        var all = ms.ToArray();
        var headerText = Encoding.ASCII.GetString(all, 0, headerEnd);
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        var first = lines.FirstOrDefault()?.Split(' ', 3);
        if (first is null || first.Length < 2) return null;
        var contentLength = 0;
        foreach (var line in lines.Skip(1))
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) int.TryParse(line[15..].Trim(), out contentLength);
        var bodyStart = headerEnd + 4;
        while (all.Length - bodyStart < contentLength)
        {
            var read = await stream.ReadAsync(buffer, ct); if (read <= 0) break;
            ms.Write(buffer, 0, read); all = ms.ToArray();
        }
        var body = contentLength > 0 && all.Length >= bodyStart ? Encoding.UTF8.GetString(all, bodyStart, Math.Min(contentLength, all.Length - bodyStart)) : "";
        return new Request(first[0].ToUpperInvariant(), first[1], body);
    }

    private static int FindHeaderEnd(byte[] data, int length)
    {
        for (var i = 0; i <= length - 4; i++)
            if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10) return i;
        return -1;
    }

    private async Task WriteJsonAsync(NetworkStream stream, int status, object payload)
    {
        var body = JsonSerializer.Serialize(payload, json);
        var bodyBytes = Encoding.UTF8.GetBytes(body);
        var reason = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 400 ? "Bad Request" : "Internal Server Error";
        var headers = $"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {bodyBytes.Length}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\nConnection: close\r\n\r\n";
        var headBytes = Encoding.ASCII.GetBytes(headers);
        await stream.WriteAsync(headBytes, cts.Token);
        await stream.WriteAsync(bodyBytes, cts.Token);
    }

    private static long ParseQueryLong(string path, string name)
    {
        var q = path.Split('?', 2); if (q.Length < 2) return 0;
        foreach (var pair in q[1].Split('&')) { var kv = pair.Split('=', 2); if (kv.Length == 2 && kv[0] == name && long.TryParse(kv[1], out var value)) return value; }
        return 0;
    }

    private sealed class StartDto
    {
        [JsonPropertyName("local_session_id")] public string LocalSessionId { get; set; } = "";
        [JsonPropertyName("meeting_code")] public string MeetingCode { get; set; } = "";
        [JsonPropertyName("meeting_url")] public string MeetingUrl { get; set; } = "";
        [JsonPropertyName("title")] public string Title { get; set; } = "Google Meet";
        [JsonPropertyName("started_at")] public string StartedAt { get; set; } = "";
        [JsonPropertyName("participants")] public List<string>? Participants { get; set; }
        public MeetStartRequest ToRequest() => new(LocalSessionId, MeetingCode, MeetingUrl, Title,
            DateTimeOffset.TryParse(StartedAt, out var dt) ? dt : DateTimeOffset.Now, Participants);
    }
    private sealed class SpeakerDto
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("confidence")] public double Confidence { get; set; } = 1;
    }
    private sealed class StateDto
    {
        [JsonPropertyName("participants")] public List<string>? Participants { get; set; }
        [JsonPropertyName("active_speaker")] public string? ActiveSpeaker { get; set; }
        [JsonPropertyName("confidence")] public double Confidence { get; set; } = 1;
    }
    private sealed class FinishDto { [JsonPropertyName("reason")] public string? Reason { get; set; } }

    public void Dispose()
    {
        cts.Cancel();
        try { listener.Stop(); } catch { }
        try { loop?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        cts.Dispose();
    }
}
