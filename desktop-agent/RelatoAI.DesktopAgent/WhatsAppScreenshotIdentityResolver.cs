using System.Diagnostics;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;

namespace RelatoAI.DesktopAgent;

internal sealed record WhatsAppScreenshotIdentity(
    string Phone,
    double Confidence,
    string Evidence);

internal static class WhatsAppScreenshotIdentityResolver
{
    private static readonly Regex PhoneRegex = new(
        @"(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?[\s.-]*)?\d{4,5}[\s.-]*\d{4}(?!\d)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static async Task<WhatsAppScreenshotIdentity?> ResolveAsync(string? knownLocalPhone)
    {
        var local = NormalizePhone(knownLocalPhone);
        var scores = new Dictionary<string, int>(StringComparer.Ordinal);
        var inspected = 0;
        foreach (var window in GetWhatsAppWindows())
        {
            var rect = GetRect(window);
            if (rect is null || rect.Value.Width < 220 || rect.Value.Height < 150) continue;
            inspected++;
            try
            {
                var textRows = await CaptureAndOcrHeaderAsync(rect.Value);
                foreach (var row in textRows)
                {
                    foreach (Match match in PhoneRegex.Matches(row.Text))
                    {
                        var phone = NormalizePhone(match.Value);
                        if (phone is null || phone == local) continue;
                        var yRatio = row.Y / Math.Max(1d, row.ImageHeight);
                        var score = yRatio <= 0.22 ? 180 : yRatio <= 0.5 ? 135 : 90;
                        scores[phone] = scores.TryGetValue(phone, out var current) ? current + score : score;
                    }
                }
            }
            catch (Exception ex) { AppendDiagnostic($"ocr-error {ex.GetType().Name}: {ex.Message}"); }
        }

        if (scores.Count == 0)
        {
            AppendDiagnostic($"no-phone windows={inspected}");
            return null;
        }
        var ranked = scores.OrderByDescending(x => x.Value).ToArray();
        var top = ranked[0];
        var margin = ranked.Length == 1 ? top.Value : top.Value - ranked[1].Value;
        if (top.Value < 135 || (ranked.Length > 1 && margin < 45)) return null;
        var confidence = top.Value >= 300 ? 0.995 : top.Value >= 180 ? 0.98 : 0.95;
        AppendDiagnostic($"phone=+{top.Key} confidence={confidence:0.000} score={top.Value} windows={inspected}");
        return new WhatsAppScreenshotIdentity(top.Key, confidence, "WHATSAPP_SCREEN_OCR");
    }
    private static async Task<List<OcrRow>> CaptureAndOcrHeaderAsync(Rectangle rect)
    {
        var isMainWindow = rect.Width >= 700;
        var left = isMainWindow ? rect.Left + (int)Math.Round(rect.Width * 0.27) : rect.Left;
        var width = isMainWindow ? Math.Max(320, rect.Right - left) : rect.Width;
        var heightRatio = isMainWindow ? 0.42 : 0.68;
        var height = Math.Max(150, (int)Math.Round(rect.Height * heightRatio));
        var crop = new Rectangle(left, rect.Top, width, Math.Min(height, rect.Height));
        var path = Path.Combine(Path.GetTempPath(), "RelatoAI", $"wa-ocr-{Guid.NewGuid():N}.png");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        const int scale = 2;
        try
        {
            using var bitmap = new Bitmap(crop.Width, crop.Height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(crop.Left, crop.Top, 0, 0, crop.Size, CopyPixelOperation.SourceCopy);

            using (var scaled = new Bitmap(crop.Width * scale, crop.Height * scale, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(scaled))
            {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(bitmap, new Rectangle(0, 0, scaled.Width, scaled.Height));
                scaled.Save(path, ImageFormat.Png);
            }

            var file = await StorageFile.GetFileFromPathAsync(path);
            using var stream = await file.OpenAsync(FileAccessMode.Read);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            using var softwareBitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            var engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine is null) return [];
            var result = await engine.RecognizeAsync(softwareBitmap);
            var rows = new List<OcrRow>();
            foreach (var line in result.Lines)
            {
                if (string.IsNullOrWhiteSpace(line.Text)) continue;
                var words = line.Words;
                var y = words.Count > 0 ? words.Min(w => w.BoundingRect.Y) : 0;
                rows.Add(new OcrRow(line.Text, y, crop.Height * scale));
            }
            return rows;
        }
        finally
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }

    private static void AppendDiagnostic(string message)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RelatoAI");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "screen-identity.log"),
                $"{DateTimeOffset.Now:O}\t{message}{Environment.NewLine}");
        }
        catch { }
    }

    private sealed record OcrRow(string Text, double Y, int ImageHeight);

    private static IEnumerable<nint> GetWhatsAppWindows()
    {
        var handles = new HashSet<nint>();
        foreach (var process in Process.GetProcesses().Where(p => p.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                if (process.MainWindowHandle != IntPtr.Zero && IsWindowVisible(process.MainWindowHandle))
                    handles.Add(process.MainWindowHandle);
            }
            catch { }
        }
        EnumWindows((handle, _) =>
        {
            try
            {
                if (!IsWindowVisible(handle)) return true;
                GetWindowThreadProcessId(handle, out var pid);
                if (pid == 0) return true;
                using var process = Process.GetProcessById((int)pid);
                if (process.ProcessName.StartsWith("WhatsApp", StringComparison.OrdinalIgnoreCase)) handles.Add(handle);
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return handles;
    }

    private static Rectangle? GetRect(nint handle)
    {
        if (!GetWindowRect(handle, out var rect)) return null;
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        return width > 0 && height > 0 ? new Rectangle(rect.Left, rect.Top, width, height) : null;
    }

    private static string? NormalizePhone(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var digits = new string(value.Where(char.IsDigit).ToArray());
        if (digits.Length == 10 || digits.Length == 11) digits = "55" + digits;
        return digits.Length is >= 12 and <= 15 ? digits : null;
    }
    private delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint hWnd, out RECT rect);
}
