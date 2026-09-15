using NAudio.Wave;

namespace RelatoAI.DesktopAgent;

internal static class AudioLevel
{
    public static bool IsActive(byte[] data, WaveFormat format, double threshold)
        => Rms(data, format) >= threshold;

    public static double Rms(byte[] data, WaveFormat format)
    {
        if (data.Length == 0) return 0;
        try
        {
            return format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32
                ? FloatRms(data)
                : format.BitsPerSample == 16 ? Pcm16Rms(data) : ByteActivity(data);
        }
        catch { return 0; }
    }

    private static double FloatRms(byte[] data)
    {
        var n = data.Length / 4; if (n == 0) return 0;
        double sum = 0;
        for (var i = 0; i < n; i++) { var v = BitConverter.ToSingle(data, i * 4); sum += v * v; }
        return Math.Sqrt(sum / n);
    }

    private static double Pcm16Rms(byte[] data)
    {
        var n = data.Length / 2; if (n == 0) return 0;
        double sum = 0;
        for (var i = 0; i < n; i++) { var v = BitConverter.ToInt16(data, i * 2) / 32768.0; sum += v * v; }
        return Math.Sqrt(sum / n);
    }

    private static double ByteActivity(byte[] data)
        => data.Count(b => b != 0) / (double)data.Length;
}
