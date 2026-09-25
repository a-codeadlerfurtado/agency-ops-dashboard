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
    private sealed record UiRect(double Left, double Top, double Width, double Height)
    {
        public double Right => Left + Width;
        public double Bottom => Top + Height;
        public bool Valid => Width > 20 && Height > 20;
    }

    private sealed record NamedElement(dynamic Element, string Name, UiRect? Rect, int ControlType);
    private sealed record Candidate(int Score, string? Name, string? Phone, string Evidence);

    private static readonly Regex PhoneRegex = new(
        @"(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?[\s.-]*)?\d{4,5}[\s.-]*\d{4}(?!\d)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex[] ExplicitContactPatterns =
    [
        new(@"(?:chamada|liga[cç][aã]o|voice call|video call|call)\s+(?:de\s+(?:voz|v[ií]deo)\s+)?(?:com|with)\s+(.{2,80})$", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new(@"^(.{2,80})\s*[–—-]\s*(?:chamada|liga[cç][aã]o|voice call|video call|call)", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new(@"(?:ligando\s+para|calling)\s+(.{2,80})$", RegexOptions.Compiled | RegexOptions.IgnoreCase),
    ];

    private static readonly string[] CallAnchorTerms =
    [
        "desligar", "encerrar", "finalizar chamada", "end call", "hang up",
        "silenciar", "mute", "microfone", "microphone",
        "câmera", "camera", "vídeo", "video", "alto-falante", "speaker",
        "adicionar participante", "add participant"
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
        "adicionar participante", "add participant", "minimizar", "maximize", "maximizar",
        "online", "digitando", "digitando…", "typing", "typing…", "gravar", "record",
        "todos", "não lidas", "nao lidas", "favoritos", "grupos", "arquivadas", "archived"
    };

    // Reads the actual WhatsApp Desktop/WebView2 accessibility tree.
    // It is called only while Windows confirms an active WhatsApp call.
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

                var windowRect = TryRect((object)window);
                var windowNames = ReadNamedElements((object)window, (object)trueCondition, 3000);
                if (windowNames.Count == 0) continue;

                var rootName = Clean(SafeCurrentName((object)window));
                if (!string.IsNullOrWhiteSpace(rootName))
                {
                    var explicitRoot = ExtractExplicitContactName(rootName, localOwnerName);
                    if (explicitRoot is not null)
                        candidates.Add(new Candidate(320, explicitRoot, PhoneFromText(rootName, knownLocalPhone), "window-explicit:" + rootName));
                    else
                    {
                        var rootPhone = PhoneFromText(rootName, knownLocalPhone);
                        var rootPerson = PersonLikeName(rootName, localOwnerName);
                        if (rootPhone is not null) candidates.Add(new Candidate(245, rootPerson, rootPhone, "window-phone:" + rootName));
                        else if (rootPerson is not null && !rootName.Equals("WhatsApp", StringComparison.OrdinalIgnoreCase))
                            candidates.Add(new Candidate(205, rootPerson, null, "window-name:" + rootName));
                    }
                }

                foreach (var node in windowNames)
                {
                    var explicitName = ExtractExplicitContactName(node.Name, localOwnerName);
                    if (explicitName is not null)
                        candidates.Add(new Candidate(300, explicitName, PhoneFromText(node.Name, knownLocalPhone), "explicit:" + node.Name));
                }

                var anchors = windowNames
                    .Where(node => CallAnchorTerms.Any(term => node.Name.Contains(term, StringComparison.OrdinalIgnoreCase)))
                    .Take(16)
                    .ToArray();

                if (anchors.Length > 0)
                {
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

                            var localNodes = ReadNamedElements((object)current, (object)trueCondition, 520);
                            if (localNodes.Count == 0) continue;
                            if (localNodes.Count > 360 && depth >= 2) break;

                            var compactBoost = localNodes.Count <= 35 ? 90 : localNodes.Count <= 90 ? 55 : localNodes.Count <= 180 ? 30 : 0;
                            var depthBoost = Math.Max(0, 90 - depth * 20);

                            foreach (var node in localNodes)
                            {
                                var explicitName = ExtractExplicitContactName(node.Name, localOwnerName);
                                if (explicitName is not null)
                                {
                                    candidates.Add(new Candidate(
                                        300 + compactBoost,
                                        explicitName,
                                        PhoneFromText(node.Name, knownLocalPhone),
                                        "call-subtree-explicit:" + node.Name));
                                    continue;
                                }

                                var phone = PhoneFromText(node.Name, knownLocalPhone);
                                if (phone is not null)
                                    candidates.Add(new Candidate(140 + compactBoost + depthBoost, null, phone, "call-subtree-phone:" + node.Name));

                                var person = PersonLikeName(node.Name, localOwnerName);
                                if (person is not null)
                                    candidates.Add(new Candidate(120 + compactBoost + depthBoost, person, null, "call-subtree-name:" + node.Name));
                            }
                        }
                    }
                }

                // Some Store/WebView2 builds do not expose semantic call labels, but they do expose
                // the visible chat/call header. While a call is active, accept only the upper-right
                // header region of the WhatsApp window; never scan the left chat list.
                if (windowRect is { Valid: true })
                {
                    foreach (var node in windowNames)
                    {
                        if (node.Rect is not { Valid: true } rect) continue;
                        var cx = rect.Left + rect.Width / 2.0;
                        var cy = rect.Top + rect.Height / 2.0;
                        var relX = (cx - windowRect.Left) / Math.Max(1, windowRect.Width);
                        var relY = (cy - windowRect.Top) / Math.Max(1, windowRect.Height);
                        if (relX < 0.34 || relX > 0.98 || relY < 0.0 || relY > 0.30) continue;
                        if (rect.Width > windowRect.Width * 0.62 || rect.Height > 100) continue;

                        var phone = PhoneFromText(node.Name, knownLocalPhone);
                        var person = PersonLikeName(node.Name, localOwnerName);
                        var isText = node.ControlType == 50020; // UIA_TextControlTypeId
                        var geometryBoost = relY <= 0.18 ? 42 : 20;
                        var textBoost = isText ? 20 : 0;
                        var anchorBoost = anchors.Length > 0 ? 35 : 0;

                        if (phone is not null)
                            candidates.Add(new Candidate(
                                205 + geometryBoost + textBoost + anchorBoost,
                                person, phone,
                                $"active-header-phone:x={relX:F2},y={relY:F2}:{node.Name}"));
                        else if (person is not null)
                            candidates.Add(new Candidate(
                                165 + geometryBoost + textBoost + anchorBoost,
                                person, null,
                                $"active-header-name:x={relX:F2},y={relY:F2}:{node.Name}"));
                    }
                }
            }

            var names = candidates.Where(x => x.Name is not null)
                .GroupBy(x => Key(x.Name!))
                .Select(group =>
                {
                    var best = group.OrderByDescending(x => x.Score).First();
                    var support = Math.Min(60, Math.Max(0, group.Count() - 1) * 12);
                    return best with { Score = best.Score + support };
                })
                .OrderByDescending(x => x.Score)
                .ToArray();

            var phones = candidates.Where(x => x.Phone is not null)
                .GroupBy(x => x.Phone!)
                .Select(group =>
                {
                    var best = group.OrderByDescending(x => x.Score).First();
                    var support = Math.Min(60, Math.Max(0, group.Count() - 1) * 12);
                    return best with { Score = best.Score + support };
                })
                .OrderByDescending(x => x.Score)
                .ToArray();

            var topName = names.FirstOrDefault();
            var topPhone = phones.FirstOrDefault();
            var nameReliable = topName?.Name is not null
                && topName.Score >= 205
                && (names.Length == 1 || topName.Score - names[1].Score >= 34);
            var phoneReliable = topPhone?.Phone is not null
                && topPhone.Score >= 220
                && (phones.Length == 1 || topPhone.Score - phones[1].Score >= 34);

            if (!nameReliable && !phoneReliable) return null;

            var confidence = nameReliable && phoneReliable ? 0.997 : nameReliable ? 0.985 : 0.98;
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

    private static List<NamedElement> ReadNamedElements(object rootObject, object conditionObject, int limit)
    {
        dynamic root = rootObject;
        dynamic condition = conditionObject;
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

                    var controlType = 0;
                    try { controlType = Convert.ToInt32(element.CurrentControlType); } catch { }
                    result.Add(new NamedElement(element, name, TryRect((object)element), controlType));
                }
                catch { }
            }
        }
        catch { }
        return result;
    }

    private static UiRect? TryRect(object elementObject)
    {
        dynamic element = elementObject;
        try
        {
            object raw = element.GetCurrentPropertyValue(30001); // UIA_BoundingRectanglePropertyId
            if (raw is Array array && array.Length >= 4)
            {
                var left = Convert.ToDouble(array.GetValue(0));
                var top = Convert.ToDouble(array.GetValue(1));
                var width = Convert.ToDouble(array.GetValue(2));
                var height = Convert.ToDouble(array.GetValue(3));
                var rect = new UiRect(left, top, width, height);
                return rect.Valid ? rect : null;
            }
        }
        catch { }

        try
        {
            dynamic rect = element.CurrentBoundingRectangle;
            var left = Convert.ToDouble(rect.left);
            var top = Convert.ToDouble(rect.top);
            var right = Convert.ToDouble(rect.right);
            var bottom = Convert.ToDouble(rect.bottom);
            var value = new UiRect(left, top, Math.Max(0, right - left), Math.Max(0, bottom - top));
            return value.Valid ? value : null;
        }
        catch { return null; }
    }

    private static string SafeCurrentName(object elementObject)
    {
        dynamic element = elementObject;
        try { return Convert.ToString(element.CurrentName) ?? ""; }
        catch { return ""; }
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
            || text.Contains("@lid", StringComparison.OrdinalIgnoreCase)
            || text.Contains("visto por último", StringComparison.OrdinalIgnoreCase)
            || text.Contains("visto por ultimo", StringComparison.OrdinalIgnoreCase)
            || text.Contains("last seen", StringComparison.OrdinalIgnoreCase)
            || text.Contains("digitando", StringComparison.OrdinalIgnoreCase)
            || text.Contains("typing", StringComparison.OrdinalIgnoreCase)) return null;
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
