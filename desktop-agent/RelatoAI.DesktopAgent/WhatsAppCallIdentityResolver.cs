using System.Text;
using System.Text.RegularExpressions;

namespace RelatoAI.DesktopAgent;

internal sealed record WhatsAppCallIdentity(
    string? LocalPhone,
    string? RemotePhone,
    string? RemoteName,
    string? Source);

internal static class WhatsAppCallIdentityResolver
{
    private static readonly Regex ChatPhoneRegex = new(
        @"(?<fromme>true|false)_(?<phone>\d{10,15})@c\.us_[A-Za-z0-9]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static async Task<WhatsAppCallIdentity> ResolveAsync(
        DateTimeOffset started,
        DateTimeOffset ended,
        string? knownLocalPhone,
        string? contactName = null)
    {
        var knownLocal = NormalizePhone(knownLocalPhone);
        var visibleName = IsGenericName(contactName) ? null : contactName?.Trim();
        WhatsAppCallIdentity best = new(knownLocal, PhoneFromVisibleText(contactName), visibleName, null);
        // IndexedDB/LevelDB do WhatsApp pode persistir o contato alguns segundos depois do fim da call.
        // Mantemos uma janela maior para evitar sessões sem prospect por uma escrita tardia do app.
        for (var attempt = 0; attempt < 24; attempt++)
        {
            var current = ResolveOnce(started, ended, best.LocalPhone, contactName);
            if (!string.IsNullOrWhiteSpace(current.LocalPhone))
                best = best with { LocalPhone = current.LocalPhone };
            if (!string.IsNullOrWhiteSpace(current.RemotePhone))
            {
                var resolvedName = current.RemoteName ?? ResolveNameForPhone(current.RemotePhone) ?? visibleName;
                return current with { LocalPhone = current.LocalPhone ?? best.LocalPhone, RemoteName = resolvedName };
            }

            if (attempt < 23)
                await Task.Delay(attempt < 2 ? 150 : 500);
        }
        if (!string.IsNullOrWhiteSpace(best.RemotePhone) && string.IsNullOrWhiteSpace(best.RemoteName))
            best = best with { RemoteName = ResolveNameForPhone(best.RemotePhone) };
        return best;
    }

    private static WhatsAppCallIdentity ResolveOnce(
        DateTimeOffset started,
        DateTimeOffset ended,
        string? knownLocalPhone,
        string? contactName)
    {
        try
        {
            var dir = ResolveLevelDbDirectory();
            if (dir is null) return new(knownLocalPhone, PhoneFromVisibleText(contactName), IsGenericName(contactName) ? null : contactName?.Trim(), null);
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
            foreach (var file in files)
            {
                var text = ReadTailLatin1(file.FullName, 4 * 1024 * 1024);
                if (string.IsNullOrEmpty(text)) continue;
                ScoreText(text, started, ended, knownLocalPhone, contactName, candidates);
            }

            var ordered = candidates
                .Where(kv => kv.Key != knownLocalPhone)
                .OrderByDescending(kv => kv.Value)
                .ToArray();
            string? remote = null;
            string? source = null;
            if (ordered.Length == 1)
            {
                remote = ordered[0].Key;
                source = ordered[0].Value >= 90_000 ? "WHATSAPP_LEVELDB_EXACT_CALL_WINDOW" : "WHATSAPP_LEVELDB_CONTACT_WINDOW";
            }
            else if (ordered.Length > 1 && ordered[0].Value >= 90_000 && ordered[0].Value - ordered[1].Value >= 12_000)
            {
                remote = ordered[0].Key;
                source = "WHATSAPP_LEVELDB_EXACT_CALL_WINDOW";
            }
            else if (ordered.Length > 1 && ordered[0].Value >= 45_000 && ordered[0].Value - ordered[1].Value >= 8_000)
            {
                remote = ordered[0].Key;
                source = "WHATSAPP_LEVELDB_CONTACT_WINDOW";
            }

            var normalizedRemote = NormalizePhone(remote);
            return new(NormalizePhone(knownLocalPhone), normalizedRemote,
                normalizedRemote is null ? (IsGenericName(contactName) ? null : contactName?.Trim()) : ResolveNameForPhone(normalizedRemote),
                source);
        }
        catch
        {
            return new(NormalizePhone(knownLocalPhone), PhoneFromVisibleText(contactName),
                IsGenericName(contactName) ? null : contactName?.Trim(), null);
        }
    }

    private static void ScoreText(
        string text,
        DateTimeOffset started,
        DateTimeOffset ended,
        string? knownLocalPhone,
        string? contactName,
        Dictionary<string, int> remoteScores)
    {
        var anchors = FindExactCallAnchors(text, started, ended);
        var contactAnchors = new List<int>();
        var normalizedContact = String.IsNullOrWhiteSpace(contactName) ? "" : contactName.Trim();
        if (normalizedContact.Length >= 3
            && !normalizedContact.Equals("Contato WhatsApp Desktop", StringComparison.OrdinalIgnoreCase)
            && !normalizedContact.Equals("WhatsApp", StringComparison.OrdinalIgnoreCase))
            AddAllIndexes(text, normalizedContact, contactAnchors);

        foreach (Match match in ChatPhoneRegex.Matches(text))
        {
            var phone = NormalizePhone(match.Groups["phone"].Value);
            if (phone is null || phone == knownLocalPhone) continue;
            if (anchors.Count > 0)
            {
                var distance = anchors.Min(anchor => Math.Abs(anchor - match.Index));
                if (distance <= 12_000) AddScore(remoteScores, phone, 100_000 - distance);
            }
            if (contactAnchors.Count > 0)
            {
                var distance = contactAnchors.Min(anchor => Math.Abs(anchor - match.Index));
                if (distance <= 8_000) AddScore(remoteScores, phone, 55_000 - distance);
            }
        }
    }

    private static List<int> FindExactCallAnchors(
        string text,
        DateTimeOffset started,
        DateTimeOffset ended)
    {
        var anchors = new List<int>();
        foreach (var moment in new[] { started, ended })
        {
            AddAllIndexes(text, moment.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"), anchors);
            AddAllIndexes(text, moment.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss"), anchors);
            AddAllIndexes(text, moment.ToUnixTimeSeconds().ToString(), anchors);
            AddAllIndexes(text, moment.ToUnixTimeMilliseconds().ToString(), anchors);
        }
        return anchors.Distinct().ToList();
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

    private static bool IsGenericName(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrWhiteSpace(text)) return true;
        return text.Equals("WhatsApp", StringComparison.OrdinalIgnoreCase)
            || text.Equals("Contato", StringComparison.OrdinalIgnoreCase)
            || text.Equals("Contato WhatsApp", StringComparison.OrdinalIgnoreCase)
            || text.Equals("Contato WhatsApp Desktop", StringComparison.OrdinalIgnoreCase);
    }

    private static string? ResolveNameForPhone(string? phone)
    {
        var normalized = NormalizePhone(phone);
        var dir = ResolveLevelDbDirectory();
        if (normalized is null || dir is null) return null;
        try
        {
            var files = Directory.EnumerateFiles(dir)
                .Where(path => path.EndsWith(".log", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith(".ldb", StringComparison.OrdinalIgnoreCase))
                .Select(path => new FileInfo(path))
                .OrderByDescending(info => info.LastWriteTimeUtc)
                .ThenByDescending(info => info.Length)
                .Take(40)
                .ToArray();

            var best = new List<(int score, string name)>();
            foreach (var file in files)
            {
                var text = ReadTailLatin1(file.FullName, 6 * 1024 * 1024);
                if (string.IsNullOrEmpty(text)) continue;
                var search = normalized;
                var offset = 0;
                while ((offset = text.IndexOf(search, offset, StringComparison.Ordinal)) >= 0)
                {
                    var start = Math.Max(0, offset - 1400);
                    var length = Math.Min(text.Length - start, 2800);
                    var window = text.Substring(start, length);
                    foreach (var field in new[] { "pushname", "name" })
                    {
                        var fieldPos = window.IndexOf(field, StringComparison.OrdinalIgnoreCase);
                        while (fieldPos >= 0)
                        {
                            var absoluteField = start + fieldPos;
                            var distance = Math.Abs(absoluteField - offset);
                            if (distance <= 1200)
                            {
                                var quote = window.IndexOf('"', fieldPos + field.Length);
                                if (quote >= 0)
                                {
                                    var end = window.IndexOf('"', quote + 1);
                                    if (end > quote + 1 && end - quote <= 180)
                                    {
                                        var candidate = window.Substring(quote + 1, end - quote - 1)
                                            .Replace("\0", " ").Trim();
                                        candidate = Regex.Replace(candidate, @"\s+", " ");
                                        if (candidate.Length >= 2 && candidate.Length <= 100
                                            && !candidate.All(char.IsDigit)
                                            && !candidate.Contains("@c.us", StringComparison.OrdinalIgnoreCase)
                                            && !candidate.Contains("@lid", StringComparison.OrdinalIgnoreCase)
                                            && !candidate.Equals("true", StringComparison.OrdinalIgnoreCase)
                                            && !candidate.Equals("false", StringComparison.OrdinalIgnoreCase))
                                        {
                                            var fieldBoost = field.Equals("pushname", StringComparison.OrdinalIgnoreCase) ? 400 : 250;
                                            best.Add((fieldBoost + Math.Max(0, 1200 - distance), candidate));
                                        }
                                    }
                                }
                            }
                            fieldPos = window.IndexOf(field, fieldPos + field.Length, StringComparison.OrdinalIgnoreCase);
                        }
                    }
                    offset += search.Length;
                }
            }
            return best.OrderByDescending(x => x.score).Select(x => x.name).FirstOrDefault();
        }
        catch { return null; }
    }

    public static string? PhoneFromVisibleText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        var digits = new string(trimmed.Where(char.IsDigit).ToArray());
        var hasPhoneShape = trimmed.Contains('+') || trimmed.Contains('(') || trimmed.Contains(')') || trimmed.Contains('-')
            || trimmed.Count(char.IsDigit) >= 10;
        return hasPhoneShape ? NormalizePhone(digits) : null;
    }

    private static string? NormalizePhone(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var digits = new string(value.Where(char.IsDigit).ToArray());
        return digits.Length is >= 10 and <= 15 ? digits : null;
    }
}
