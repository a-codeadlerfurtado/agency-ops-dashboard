using System.Text;
using System.Text.RegularExpressions;

namespace RelatoAI.DesktopAgent;

internal sealed record WhatsAppCallIdentity(
    string? LocalPhone,
    string? RemotePhone,
    string? Source);

internal static class WhatsAppCallIdentityResolver
{
    private static readonly Regex ChatPhoneRegex = new(
        @"(?<fromme>true|false)_(?<phone>\d{10,15})@c\.us_[A-Za-z0-9]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex AnyPhoneRegex = new(
        @"(?<phone>\d{10,15})@c\.us",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static async Task<WhatsAppCallIdentity> ResolveAsync(
        DateTimeOffset started,
        DateTimeOffset ended,
        string? knownLocalPhone)
    {
        var knownLocal = NormalizePhone(knownLocalPhone);
        WhatsAppCallIdentity best = new(knownLocal, null, null);
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var current = ResolveOnce(started, ended, best.LocalPhone);
            if (!string.IsNullOrWhiteSpace(current.LocalPhone))
                best = best with { LocalPhone = current.LocalPhone };
            if (!string.IsNullOrWhiteSpace(current.RemotePhone))
                return current with { LocalPhone = current.LocalPhone ?? best.LocalPhone };

            if (attempt < 7)
                await Task.Delay(attempt == 0 ? 100 : 250);
        }
        return best;
    }

    private static WhatsAppCallIdentity ResolveOnce(
        DateTimeOffset started,
        DateTimeOffset ended,
        string? knownLocalPhone)
    {
        try
        {
            var dir = ResolveLevelDbDirectory();
            if (dir is null) return new(knownLocalPhone, null, null);
            var minWrite = started.UtcDateTime.AddMinutes(-3);
            var files = Directory.EnumerateFiles(dir)
                .Where(path => path.EndsWith(".log", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith(".ldb", StringComparison.OrdinalIgnoreCase))
                .Select(path => new FileInfo(path))
                .Where(info => info.LastWriteTimeUtc >= minWrite)
                .OrderByDescending(info => info.LastWriteTimeUtc)
                .ThenByDescending(info => info.Length)
                .Take(18)
                .ToArray();

            var candidates = new Dictionary<string, int>(StringComparer.Ordinal);
            var localCandidates = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var file in files)
            {
                var text = ReadTailLatin1(file.FullName, 4 * 1024 * 1024);
                if (string.IsNullOrEmpty(text)) continue;
                ScoreText(text, started, ended, knownLocalPhone, candidates, localCandidates);
            }

            var remote = candidates
                .Where(kv => kv.Key != knownLocalPhone)
                .OrderByDescending(kv => kv.Value)
                .Select(kv => kv.Key)
                .FirstOrDefault();

            var local = knownLocalPhone;
            if (string.IsNullOrWhiteSpace(local))
            {
                local = localCandidates
                    .Where(kv => kv.Key != remote)
                    .OrderByDescending(kv => kv.Value)
                    .Select(kv => kv.Key)
                    .FirstOrDefault();
            }

            return new(NormalizePhone(local), NormalizePhone(remote),
                string.IsNullOrWhiteSpace(remote) ? null : "WHATSAPP_LEVELDB_CALL_CONTEXT");
        }
        catch
        {
            return new(NormalizePhone(knownLocalPhone), null, null);
        }
    }

    private static void ScoreText(
        string text,
        DateTimeOffset started,
        DateTimeOffset ended,
        string? knownLocalPhone,
        Dictionary<string, int> remoteScores,
        Dictionary<string, int> localScores)
    {
        var anchors = FindAnchors(text, started, ended);
        foreach (Match match in ChatPhoneRegex.Matches(text))
        {
            var phone = NormalizePhone(match.Groups["phone"].Value);
            if (phone is null) continue;

            var score = match.Groups["fromme"].Value.Equals("true", StringComparison.OrdinalIgnoreCase) ? 30 : 18;
            score += ProximityScore(match.Index, anchors);
            if (phone == knownLocalPhone) score -= 100;
            AddScore(remoteScores, phone, score);

            if (match.Groups["fromme"].Value.Equals("true", StringComparison.OrdinalIgnoreCase))
                ScoreNearbyLocalPhones(text, match.Index, match.Length, phone, localScores);
        }
    }

    private static void ScoreNearbyLocalPhones(
        string text,
        int matchIndex,
        int matchLength,
        string remotePhone,
        Dictionary<string, int> localScores)
    {
        var start = Math.Max(0, matchIndex - 4096);
        var end = Math.Min(text.Length, matchIndex + matchLength + 4096);
        var window = text.Substring(start, end - start);
        foreach (Match nearby in AnyPhoneRegex.Matches(window))
        {
            var phone = NormalizePhone(nearby.Groups["phone"].Value);
            if (phone is null || phone == remotePhone) continue;
            AddScore(localScores, phone, 12);
        }
    }

    private static List<int> FindAnchors(
        string text,
        DateTimeOffset started,
        DateTimeOffset ended)
    {
        var anchors = new List<int>();
        AddAllIndexes(text, started.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"), anchors);
        AddAllIndexes(text, ended.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"), anchors);
        if (anchors.Count > 0) return anchors;

        var callAnchors = new List<int>();
        AddAllIndexes(text, "call_log", callAnchors);
        return callAnchors.TakeLast(8).ToList();
    }

    private static void AddAllIndexes(string text, string needle, List<int> output)
    {
        var index = 0;
        while ((index = text.IndexOf(needle, index, StringComparison.OrdinalIgnoreCase)) >= 0)
        {
            output.Add(index);
            index += Math.Max(1, needle.Length);
        }
    }

    private static int ProximityScore(int index, List<int> anchors)
    {
        if (anchors.Count == 0) return 0;
        var distance = anchors.Min(anchor => Math.Abs(anchor - index));
        if (distance <= 8_000) return 70;
        if (distance <= 64_000) return 40;
        if (distance <= 256_000) return 15;
        return 0;
    }

    private static string? ResolveLevelDbDirectory()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var packages = Path.Combine(local, "Packages");
        if (!Directory.Exists(packages)) return null;

        foreach (var package in Directory.EnumerateDirectories(packages, "*WhatsAppDesktop*"))
        {
            var path = Path.Combine(package, "LocalCache", "EBWebView", "Default", "IndexedDB",
                "https_web.whatsapp.com_0.indexeddb.leveldb");
            if (Directory.Exists(path)) return path;
        }
        return null;
    }

    private static string ReadTailLatin1(string path, int maxBytes)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var take = (int)Math.Min(maxBytes, stream.Length);
            if (take <= 0) return string.Empty;
            stream.Seek(-take, SeekOrigin.End);
            var buffer = new byte[take];
            var read = 0;
            while (read < take)
            {
                var n = stream.Read(buffer, read, take - read);
                if (n <= 0) break;
                read += n;
            }
            return Encoding.Latin1.GetString(buffer, 0, read);
        }
        catch { return string.Empty; }
    }

    private static void AddScore(Dictionary<string, int> scores, string phone, int score)
    {
        if (score <= 0) return;
        scores[phone] = scores.TryGetValue(phone, out var current) ? Math.Max(current, score) : score;
    }

    private static string? NormalizePhone(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var digits = new string(value.Where(char.IsDigit).ToArray());
        return digits.Length is >= 10 and <= 15 ? digits : null;
    }
}
