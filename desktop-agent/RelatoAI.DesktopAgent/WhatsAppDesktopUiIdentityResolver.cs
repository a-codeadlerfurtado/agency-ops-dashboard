using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Automation;

namespace RelatoAI.DesktopAgent;

internal sealed record WhatsAppDesktopUiIdentity(
    string? Name,
    string? Phone,
    string Source,
    double Confidence,
    string Evidence);

internal static class WhatsAppDesktopUiIdentityResolver
{
    private sealed record UiNode(string Text, Rect Bounds, ControlType ControlType);

    private static readonly Regex PhoneRegex = new(
        @"(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?[\s.-]*)?\d{4,5}[\s.-]*\d{4}(?!\d)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex[] ExplicitContactPatterns =
    [
        new(@"(?:chamada|liga[cç][aã]o|voice call|video call|call)\s+(?:de\s+(?:voz|v[ií]deo)\s+)?(?:com|with)\s+(.{2,80})$", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new(@"^(.{2,80})\s*[–—-]\s*(?:chamada|liga[cç][aã]o|voice call|video call|call)", RegexOptions.Compiled | RegexOptions.IgnoreCase),
    ];

    private static readonly string[] CallAnchorTerms =
    [
        "desligar", "encerrar", "finalizar chamada", "end call", "hang up",
        "silenciar", "mute", "microfone", "microphone",
        "câmera", "camera", "vídeo", "video"
    ];

    private static readonly HashSet<string> GenericNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "whatsapp", "chamada", "chamadas", "ligação", "ligações", "voice call", "video call",
        "conversas", "conversa", "chats", "chat", "pesquisar", "buscar", "search",
        "mensagem", "mensagens", "message", "messages", "contato", "contatos",
        "silenciar", "mute", "microfone", "microphone", "câmera", "camera", "vídeo", "video",
        "desligar", "encerrar", "end call", "atender", "recusar", "speaker", "alto-falante",
        "mais", "more", "voltar", "back", "status", "comunidades", "communities",
        "nova conversa", "new chat", "configurações", "settings", "perfil", "profile"
    };

    public static WhatsAppDesktopUiIdentity? Resolve(string? knownLocalPhone)
    {
        try
        {
            var pids = Process.GetProcesses()
                .Where(p => p.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase))
                .Select(p => p.Id)
                .ToHashSet();
            if (pids.Count == 0) return null;

            var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            var best = new List<(int Score, string? Name, string? Phone, string Evidence)>();

            for (var i = 0; i < windows.Count; i++)
            {
                AutomationElement window;
                try
                {
                    window = windows[i];
                    if (!pids.Contains(window.Current.ProcessId)) continue;
                }
                catch { continue; }

                var nodes = ReadNodes(window);
                if (nodes.Count == 0) continue;

                var anchors = nodes
                    .Where(node => CallAnchorTerms.Any(term => node.Text.Contains(term, StringComparison.OrdinalIgnoreCase)))
                    .ToArray();
                if (anchors.Length == 0) continue;

                Rect windowBounds;
                string windowTitle;
                try
                {
                    windowBounds = window.Current.BoundingRectangle;
                    windowTitle = Clean(window.Current.Name);
                }
                catch
                {
                    windowBounds = Rect.Empty;
                    windowTitle = "";
                }

                foreach (var node in nodes)
                {
                    var text = node.Text;
                    if (string.IsNullOrWhiteSpace(text)) continue;

                    var explicitName = ExtractExplicitContactName(text);
                    if (explicitName is not null)
                    {
                        var explicitPhone = PhoneFromText(text, knownLocalPhone);
                        best.Add((170, explicitName, explicitPhone, $"explicit:{text}"));
                    }

                    var phone = PhoneFromText(text, knownLocalPhone);
                    if (phone is not null)
                    {
                        var score = 80 + ProximityScore(node.Bounds, anchors);
                        if (IsTopHeader(node.Bounds, windowBounds)) score += 30;
                        best.Add((score, null, phone, $"phone:{text}"));
                    }

                    var name = PersonLikeName(text);
                    if (name is null) continue;
                    var nameScore = 35 + ProximityScore(node.Bounds, anchors);
                    if (node.ControlType == ControlType.Text) nameScore += 15;
                    if (IsTopHeader(node.Bounds, windowBounds)) nameScore += 45;
                    if (text.Equals(windowTitle, StringComparison.OrdinalIgnoreCase)) nameScore += 25;
                    if (nameScore >= 90)
                        best.Add((nameScore, name, null, $"ui:{text}"));
                }

                var titleName = PersonLikeName(windowTitle);
                if (titleName is not null)
                    best.Add((115, titleName, PhoneFromText(windowTitle, knownLocalPhone), $"title:{windowTitle}"));
            }

            var names = best.Where(x => x.Name is not null)
                .GroupBy(x => Key(x.Name!))
                .Select(g => g.OrderByDescending(x => x.Score).First())
                .OrderByDescending(x => x.Score)
                .ToArray();
            var phones = best.Where(x => x.Phone is not null)
                .GroupBy(x => x.Phone!)
                .Select(g => g.OrderByDescending(x => x.Score).First())
                .OrderByDescending(x => x.Score)
                .ToArray();

            var topName = names.FirstOrDefault();
            var topPhone = phones.FirstOrDefault();
            var nameReliable = topName.Name is not null && topName.Score >= 95
                && (names.Length == 1 || topName.Score - names[1].Score >= 20);
            var phoneReliable = topPhone.Phone is not null && topPhone.Score >= 100
                && (phones.Length == 1 || topPhone.Score - phones[1].Score >= 20);

            if (!nameReliable && !phoneReliable) return null;

            var confidence = nameReliable && phoneReliable ? 0.99 : nameReliable ? 0.96 : 0.94;
            var evidence = string.Join(" | ", new[]
            {
                nameReliable ? topName.Evidence : null,
                phoneReliable ? topPhone.Evidence : null
            }.Where(x => !string.IsNullOrWhiteSpace(x)));

            return new WhatsAppDesktopUiIdentity(
                nameReliable ? topName.Name : null,
                phoneReliable ? topPhone.Phone : null,
                "WHATSAPP_DESKTOP_UI",
                confidence,
                evidence);
        }
        catch
        {
            return null;
        }
    }

    private static List<UiNode> ReadNodes(AutomationElement window)
    {
        var output = new List<UiNode>();
        try
        {
            var condition = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Pane),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group));
            var all = window.FindAll(TreeScope.Descendants, condition);
            var limit = Math.Min(all.Count, 3500);
            for (var i = 0; i < limit; i++)
            {
                try
                {
                    var element = all[i];
                    if (element.Current.IsOffscreen) continue;
                    var text = Clean(element.Current.Name);
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    output.Add(new UiNode(text, element.Current.BoundingRectangle, element.Current.ControlType));
                }
                catch { }
            }
        }
        catch { }
        return output;
    }

    private static string? ExtractExplicitContactName(string value)
    {
        foreach (var pattern in ExplicitContactPatterns)
        {
            var match = pattern.Match(value);
            if (!match.Success) continue;
            var raw = match.Groups[1].Value.Trim();
            var phone = PhoneFromText(raw, null);
            if (phone is not null) return null;
            var name = PersonLikeName(raw);
            if (name is not null) return name;
        }
        return null;
    }

    private static string? PersonLikeName(string value)
    {
        var text = Clean(value);
        if (string.IsNullOrWhiteSpace(text) || text.Length < 2 || text.Length > 80) return null;
        if (GenericNames.Contains(text)) return null;
        if (CallAnchorTerms.Any(term => text.Equals(term, StringComparison.OrdinalIgnoreCase))) return null;
        if (PhoneFromText(text, null) is not null) return null;
        if (text.Contains("http", StringComparison.OrdinalIgnoreCase) || text.Contains("@c.us", StringComparison.OrdinalIgnoreCase)
            || text.Contains("@lid", StringComparison.OrdinalIgnoreCase)) return null;
        var letters = text.Count(char.IsLetter);
        if (letters < 2) return null;
        if (text.Count(char.IsWhiteSpace) > 7) return null;
        if (text.EndsWith("...", StringComparison.Ordinal) || text.Length > 55 && text.Contains(' ')) return null;
        return text;
    }

    private static int ProximityScore(Rect candidate, IReadOnlyList<UiNode> anchors)
    {
        if (candidate.IsEmpty || anchors.Count == 0) return 0;
        var cx = candidate.Left + candidate.Width / 2;
        var cy = candidate.Top + candidate.Height / 2;
        var best = double.MaxValue;
        foreach (var anchor in anchors)
        {
            if (anchor.Bounds.IsEmpty) continue;
            var ax = anchor.Bounds.Left + anchor.Bounds.Width / 2;
            var ay = anchor.Bounds.Top + anchor.Bounds.Height / 2;
            var distance = Math.Sqrt(Math.Pow(cx - ax, 2) + Math.Pow(cy - ay, 2));
            if (distance < best) best = distance;
        }
        if (best <= 220) return 80;
        if (best <= 420) return 60;
        if (best <= 700) return 35;
        return 0;
    }

    private static bool IsTopHeader(Rect candidate, Rect window)
    {
        if (candidate.IsEmpty || window.IsEmpty || window.Height <= 0) return false;
        var centerY = candidate.Top + candidate.Height / 2;
        return centerY <= window.Top + Math.Min(320, window.Height * 0.38);
    }

    private static string? PhoneFromText(string? value, string? knownLocalPhone)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var local = NormalizePhone(knownLocalPhone);
        foreach (Match match in PhoneRegex.Matches(value))
        {
            var phone = NormalizePhone(match.Value);
            if (phone is null || phone == local) continue;
            return phone;
        }
        return null;
    }

    private static string Key(string value) => Regex.Replace(
        value.Normalize(System.Text.NormalizationForm.FormD),
        @"\p{Mn}+", "").ToLowerInvariant().Replace(" ", "");

    private static string Clean(string? value) => Regex.Replace(value ?? "", @"\s+", " ").Trim();

    private static string? NormalizePhone(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var digits = new string(value.Where(char.IsDigit).ToArray());
        if (digits.Length == 10 || digits.Length == 11) digits = "55" + digits;
        return digits.Length is >= 12 and <= 15 ? digits : null;
    }
}
