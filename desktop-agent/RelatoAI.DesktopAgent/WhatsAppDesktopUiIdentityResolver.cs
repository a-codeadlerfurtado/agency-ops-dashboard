using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace RelatoAI.DesktopAgent;

internal sealed record WhatsAppDesktopUiIdentity(
    string? Name,
    string? Phone,
    string Source,
    double Confidence,
    string Evidence);

internal static class WhatsAppDesktopUiIdentityResolver
{
    private sealed record Candidate(int Score, string? Name, string? Phone, string Evidence);

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
        "câmera", "camera", "vídeo", "video", "alto-falante", "speaker"
    ];

    private static readonly HashSet<string> GenericNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "whatsapp", "chamada", "chamadas", "ligação", "ligações", "voice call", "video call",
        "conversas", "conversa", "chats", "chat", "pesquisar", "buscar", "search",
        "mensagem", "mensagens", "message", "messages", "contato", "contatos",
        "silenciar", "mute", "microfone", "microphone", "câmera", "camera", "vídeo", "video",
        "desligar", "encerrar", "end call", "atender", "recusar", "speaker", "alto-falante",
        "mais", "more", "voltar", "back", "status", "comunidades", "communities",
        "nova conversa", "new chat", "configurações", "settings", "perfil", "profile",
        "adicionar participante", "add participant", "minimizar", "maximize", "maximizar"
    };

    // Uses the native Windows UI Automation COM API through late binding.
    // This keeps the agent dependency-free while reading the actual WhatsApp Desktop/WebView2 accessibility tree.
    public static WhatsAppDesktopUiIdentity? Resolve(string? knownLocalPhone, string? localOwnerName = null)
    {
        object? automationObject = null;
        try
        {
            var automationType = Type.GetTypeFromProgID("UIAutomationClient.CUIAutomation");
            if (automationType is null) return null;
            automationObject = Activator.CreateInstance(automationType);
            if (automationObject is null) return null;
            dynamic automation = automationObject;

            var pids = Process.GetProcesses()
                .Where(p => p.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase))
                .Select(p => p.Id)
                .ToHashSet();
            if (pids.Count == 0) return null;

            dynamic trueCondition = automation.CreateTrueCondition();
            dynamic windows = automation.GetRootElement().FindAll(2, trueCondition); // TreeScope_Children
            var candidates = new List<Candidate>();

            for (var i = 0; i < SafeLength(windows); i++)
            {
                dynamic window;
                try
                {
                    window = windows.GetElement(i);
                    if (!pids.Contains((int)window.CurrentProcessId)) continue;
                }
                catch { continue; }

                var windowNames = ReadNamedElements(window, trueCondition, 2500);
                if (windowNames.Count == 0) continue;

                foreach (var node in windowNames)
                {
                    var explicitName = ExtractExplicitContactName(node.Name, localOwnerName);
                    if (explicitName is not null)
                        candidates.Add(new Candidate(220, explicitName, PhoneFromText(node.Name, knownLocalPhone), "explicit:" + node.Name));
                }

                var anchors = windowNames
                    .Where(node => CallAnchorTerms.Any(term => node.Name.Contains(term, StringComparison.OrdinalIgnoreCase)))
                    .Take(12)
                    .ToArray();
                if (anchors.Length == 0) continue;

                dynamic walker = automation.ControlViewWalker;
                foreach (var anchor in anchors)
                {
                    dynamic current = anchor.Element;
                    for (var depth = 0; depth < 5; depth++)
                    {
                        try
                        {
                            current = walker.GetParentElement(current);
                            if (current is null) break;
                        }
                        catch { break; }

                        var localNodes = ReadNamedElements(current, trueCondition, 420);
                        if (localNodes.Count == 0) continue;
                        if (localNodes.Count > 300 && depth >= 2) break;

                        var compactBoost = localNodes.Count <= 35 ? 70 : localNodes.Count <= 90 ? 40 : localNodes.Count <= 180 ? 20 : 0;
                        var depthBoost = Math.Max(0, 80 - depth * 18);

                        foreach (var node in localNodes)
                        {
                            var explicitName = ExtractExplicitContactName(node.Name, localOwnerName);
                            if (explicitName is not null)
                            {
                                candidates.Add(new Candidate(
                                    230 + compactBoost,
                                    explicitName,
                                    PhoneFromText(node.Name, knownLocalPhone),
                                    "call-subtree-explicit:" + node.Name));
                                continue;
                            }

                            var phone = PhoneFromText(node.Name, knownLocalPhone);
                            if (phone is not null)
                                candidates.Add(new Candidate(95 + compactBoost + depthBoost, null, phone, "call-subtree-phone:" + node.Name));

                            var person = PersonLikeName(node.Name, localOwnerName);
                            if (person is not null)
                                candidates.Add(new Candidate(80 + compactBoost + depthBoost, person, null, "call-subtree-name:" + node.Name));
                        }
                    }
                }
            }

            var names = candidates.Where(x => x.Name is not null)
                .GroupBy(x => Key(x.Name!))
                .Select(group =>
                {
                    var best = group.OrderByDescending(x => x.Score).First();
                    var support = Math.Min(45, group.Count() * 8);
                    return best with { Score = best.Score + support };
                })
                .OrderByDescending(x => x.Score)
                .ToArray();

            var phones = candidates.Where(x => x.Phone is not null)
                .GroupBy(x => x.Phone!)
                .Select(group =>
                {
                    var best = group.OrderByDescending(x => x.Score).First();
                    var support = Math.Min(45, group.Count() * 8);
                    return best with { Score = best.Score + support };
                })
                .OrderByDescending(x => x.Score)
                .ToArray();

            var topName = names.FirstOrDefault();
            var topPhone = phones.FirstOrDefault();
            var nameReliable = topName?.Name is not null
                && topName.Score >= 180
                && (names.Length == 1 || topName.Score - names[1].Score >= 28);
            var phoneReliable = topPhone?.Phone is not null
                && topPhone.Score >= 180
                && (phones.Length == 1 || topPhone.Score - phones[1].Score >= 28);

            if (!nameReliable && !phoneReliable) return null;

            var confidence = nameReliable && phoneReliable ? 0.995 : nameReliable ? 0.98 : 0.97;
            var evidence = string.Join(" | ", new[]
            {
                nameReliable ? topName!.Evidence : null,
                phoneReliable ? topPhone!.Evidence : null
            }.Where(x => !string.IsNullOrWhiteSpace(x)));

            return new WhatsAppDesktopUiIdentity(
                nameReliable ? topName!.Name : null,
                phoneReliable ? topPhone!.Phone : null,
                "WHATSAPP_DESKTOP_UI",
                confidence,
                evidence);
        }
        catch
        {
            return null;
        }
        finally
        {
            if (automationObject is not null && Marshal.IsComObject(automationObject))
            {
                try { Marshal.FinalReleaseComObject(automationObject); } catch { }
            }
        }
    }

    private sealed record NamedElement(dynamic Element, string Name);

    private static List<NamedElement> ReadNamedElements(dynamic root, dynamic condition, int limit)
    {
        var result = new List<NamedElement>();
        try
        {
            dynamic all = root.FindAll(4, condition); // TreeScope_Descendants
            var count = Math.Min(SafeLength(all), limit);
            for (var i = 0; i < count; i++)
            {
                try
                {
                    dynamic element = all.GetElement(i);
                    var name = Clean(Convert.ToString(element.CurrentName));
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    bool offscreen;
                    try { offscreen = Convert.ToBoolean(element.CurrentIsOffscreen); }
                    catch { offscreen = false; }
                    if (offscreen) continue;
                    result.Add(new NamedElement(element, name));
                }
                catch { }
            }
        }
        catch { }
        return result;
    }

    private static int SafeLength(dynamic collection)
    {
        try { return Math.Max(0, Convert.ToInt32(collection.Length)); }
        catch
        {
            try { return Math.Max(0, Convert.ToInt32(collection.Count)); }
            catch { return 0; }
        }
    }

    private static string? ExtractExplicitContactName(string value, string? localOwnerName)
    {
        foreach (var pattern in ExplicitContactPatterns)
        {
            var match = pattern.Match(value);
            if (!match.Success) continue;
            var raw = match.Groups[1].Value.Trim();
            if (PhoneFromText(raw, null) is not null) return null;
            var name = PersonLikeName(raw, localOwnerName);
            if (name is not null) return name;
        }
        return null;
    }

    private static string? PersonLikeName(string value, string? localOwnerName)
    {
        var text = Clean(value);
        if (string.IsNullOrWhiteSpace(text) || text.Length < 2 || text.Length > 80) return null;
        if (GenericNames.Contains(text)) return null;
        if (!string.IsNullOrWhiteSpace(localOwnerName) && Key(text) == Key(localOwnerName)) return null;
        if (CallAnchorTerms.Any(term => text.Equals(term, StringComparison.OrdinalIgnoreCase))) return null;
        if (PhoneFromText(text, null) is not null) return null;
        if (text.Contains("http", StringComparison.OrdinalIgnoreCase)
            || text.Contains("@c.us", StringComparison.OrdinalIgnoreCase)
            || text.Contains("@lid", StringComparison.OrdinalIgnoreCase)) return null;
        var letters = text.Count(char.IsLetter);
        if (letters < 2) return null;
        if (text.Count(char.IsWhiteSpace) > 6) return null;
        if (text.EndsWith("...", StringComparison.Ordinal)) return null;
        return text;
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
