using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed record MeetingAudioOutboxItem(
    string LocalSessionId,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    string LocalPath,
    string RemotePath,
    string? MixedPath,
    string State,
    int Attempts,
    string? LastError,
    DateTimeOffset UpdatedAt);

internal static class MeetingAudioOutbox
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RelatoAI", "MeetingOutbox");

    public static MeetingAudioOutboxItem Create(MeetStartRequest meeting)
    {
        var dir = SessionDir(meeting.LocalSessionId);
        Directory.CreateDirectory(dir);
        var item = new MeetingAudioOutboxItem(
            meeting.LocalSessionId,
            meeting.StartedAt,
            null,
            Path.Combine(dir, "local.wav"),
            Path.Combine(dir, "remote.wav"),
            Path.Combine(dir, "meeting.mp3"),
            "RECORDING",
            0,
            null,
            DateTimeOffset.Now);
        Save(item);
        return item;
    }

    public static MeetingAudioOutboxItem MarkRecorded(MeetingAudioOutboxItem item, DateTimeOffset endedAt)
    {
        var next = item with { EndedAt = endedAt, State = "RECORDED_LOCAL", LastError = null, UpdatedAt = DateTimeOffset.Now };
        Save(next);
        return next;
    }

    public static MeetingAudioOutboxItem MarkUploading(MeetingAudioOutboxItem item)
    {
        var next = item with { State = "UPLOADING", LastError = null, UpdatedAt = DateTimeOffset.Now };
        Save(next);
        return next;
    }

    public static MeetingAudioOutboxItem MarkFailed(MeetingAudioOutboxItem item, Exception error)
    {
        var next = item with
        {
            State = "UPLOAD_FAILED",
            Attempts = item.Attempts + 1,
            LastError = error.Message,
            UpdatedAt = DateTimeOffset.Now
        };
        Save(next);
        return next;
    }

    public static IReadOnlyList<MeetingAudioOutboxItem> LoadPending()
    {
        Directory.CreateDirectory(Root);
        var rows = new List<MeetingAudioOutboxItem>();
        foreach (var manifest in Directory.EnumerateFiles(Root, "manifest.json", SearchOption.AllDirectories))
        {
            try
            {
                var item = JsonSerializer.Deserialize<MeetingAudioOutboxItem>(File.ReadAllText(manifest));
                if (item is not null && item.State != "STORED") rows.Add(item);
            }
            catch { }
        }
        return rows.OrderBy(x => x.StartedAt).ToArray();
    }

    public static void Save(MeetingAudioOutboxItem item)
    {
        var dir = SessionDir(item.LocalSessionId);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "manifest.json");
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(item, JsonOptions));
        File.Move(temp, path, true);
    }

    public static void Remove(MeetingAudioOutboxItem item)
    {
        var dir = SessionDir(item.LocalSessionId);
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
        catch { }
    }

    private static string SessionDir(string localSessionId)
    {
        var safe = string.Concat(localSessionId.Select(c => char.IsLetterOrDigit(c) || c is '.' or '_' or '-' ? c : '_'));
        if (safe.Length > 180) safe = safe[..180];
        return Path.Combine(Root, string.IsNullOrWhiteSpace(safe) ? "session" : safe);
    }
}
