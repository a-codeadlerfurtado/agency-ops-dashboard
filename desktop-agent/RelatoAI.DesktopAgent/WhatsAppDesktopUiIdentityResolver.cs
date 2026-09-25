using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace RelatoAI.DesktopAgent;

internal sealed record WhatsAppDesktopUiIdentity(
    string? Name,
    string? Phone,
    string? Source,
    double Confidence,
    string? Evidence);

internal static class WhatsAppDesktopUiIdentityResolver
{
    private static readonly Regex PhoneRegex = new(
        @"(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?[\s\-.]*)?\d{4,5}[\s\-.]*\d{4}(?!\d)",
        RegexOptions.Compiled);

    private static readonly Regex CallNameRegex = new(
        @"(?:chamada(?:\s+de\s+voz|\s+de\s+vídeo)?\s+(?:com|para)|ligando\s+para|calling|call\s+with)\s*[:\-]?\s*(?<name>[^\r\n]{2,80})",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly HashSet<string> Ignore = new(StringComparer.OrdinalIgnoreCase)
    {
        "WhatsApp","Chamadas","Ligações","Chamada de voz","Chamada de vídeo","Encerrar","Desligar",
        "Silenciar","Mudo","Microfone","Câmera","Camera","Adicionar participante","Participantes",
        "Voltar","Pesquisar","Search","Menu","Mais opções","Minimizar","Maximizar","Fechar",
        "Atender","Recusar","Em chamada","Ligação em andamento","Chamada em andamento"
    };

    public static WhatsAppDesktopUiIdentity? TryResolve()
    {
        try
        {
            var whatsappPids = Process.GetProcesses()
                .Where(p => p.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase))
                .Select(p => p.Id)
                .ToHashSet();
            if (whatsappPids.Count == 0) return null;

            var roots = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)
                .Cast<AutomationElement>()
                .Where(el =>
                {
                    try { return whatsappPids.Contains(el.Current.ProcessId) && !el.Current.BoundingRectangle.IsEmpty; }
                    catch { return false; }
                })
                .ToArray();

            var best = new List<(int score, string? name, string? phone, string evidence)>();
            foreach (var root in roots)
            {
                var windowName = SafeName(root);
                var rect = SafeRect(root);
                if (!string.IsNullOrWhiteSpace(windowName) && !windowName.Equals("WhatsApp", StringComparison.OrdinalIgnoreCase))
                    ScoreText(windowName, 120, best, "window_title");

                AutomationElementCollection nodes;
                try { nodes = root.FindAll(TreeScope.Descendants, Condition.TrueCondition); }
                catch { continue; }

                var take = Math.Min(nodes.Count, 900);
                for (var i = 0; i < take; i++)
                {
                    AutomationElement node;
                    try { node = nodes[i]; } catch { continue; }
                    var name = SafeName(node);
                    if (string.IsNullOrWhiteSpace(name) || name.Length > 180) continue;
                    var bounds = SafeRect(node);
                    if (bounds.IsEmpty) continue;

                    var score = 0;
                    if (!rect.IsEmpty)
                    {
                        var relativeY = (bounds.Top - rect.Top) / Math.Max(1, rect.Height);
                        if (relativeY >= 0 && relativeY <= .38) score += 70;
                        else if (relativeY <= .62) score += 25;
                        else score -= 25;
                    }

                    try
                    {
                        var type = node.Current.ControlType;
                        if (type == ControlType.Text) score += 30;
                        if (type == ControlType.Button) score += 5;
                    }
                    catch { }

                    ScoreText(name, score, best, "uia");
                }
            }

            var winner = best.OrderByDescending(x => x.score).FirstOrDefault();
            if (winner.score < 80) return null;
            return new WhatsAppDesktopUiIdentity(
                winner.name,
                winner.phone,
                "WHATSAPP_DESKTOP_UIA",
                Math.Min(0.99, 0.70 + Math.Max(0, winner.score - 80) / 500.0),
                winner.evidence);
        }
        catch
        {
            return null;
        }
    }

    private static void ScoreText(
        string raw,
        int baseScore,
        List<(int score, string? name, string? phone, string evidence)> output,
        string source)
    {
        var text = Regex.Replace(raw ?? "", @"\s+", " ").Trim();
        if (string.IsNullOrWhiteSpace(text)) return;

        var callMatch = CallNameRegex.Match(text);
        if (callMatch.Success)
        {
            var callName = CleanName(callMatch.Groups["name"].Value);
            var callPhone = NormalizePhone(text);
            if (callName is not null || callPhone is not null)
                output.Add((baseScore + 180, callName, callPhone, source + ":call_label:" + text[..Math.Min(text.Length, 120)]));
        }

        var phone = NormalizePhone(text);
        var name = CleanName(text);
        if (phone is not null)
            output.Add((baseScore + 130, name, phone, source + ":phone:" + text[..Math.Min(text.Length, 120)]));
        else if (name is not null)
            output.Add((baseScore + 35, name, null, source + ":name:" + text[..Math.Min(text.Length, 120)]));
    }

    private static string? CleanName(string? value)
    {
        var text = Regex.Replace(value ?? "", @"\s+", " ").Trim();
        if (text.Length < 2 || text.Length > 100) return null;
        if (Ignore.Contains(text)) return null;
        if (PhoneRegex.IsMatch(text) && text.Count(char.IsLetter) < 2) return null;
        if (text.Contains("WhatsApp", StringComparison.OrdinalIgnoreCase) && text.Length < 35) return null;
        if (text.Any(ch => char.IsControl(ch))) return null;
        var letters = text.Count(char.IsLetter);
        if (letters < 2) return null;
        if (text.Count(char.IsDigit) > Math.Max(3, text.Length / 2)) return null;
        return text;
    }

    private static string? NormalizePhone(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var match = PhoneRegex.Match(value);
        if (!match.Success) return null;
        var digits = new string(match.Value.Where(char.IsDigit).ToArray());
        if (digits.Length is 10 or 11) digits = "55" + digits;
        return digits.Length is >= 12 and <= 13 ? digits : null;
    }

    private static string SafeName(AutomationElement element)
    {
        try { return element.Current.Name?.Trim() ?? ""; }
        catch { return ""; }
    }

    private static System.Windows.Rect SafeRect(AutomationElement element)
    {
        try { return element.Current.BoundingRectangle; }
        catch { return System.Windows.Rect.Empty; }
    }
}
