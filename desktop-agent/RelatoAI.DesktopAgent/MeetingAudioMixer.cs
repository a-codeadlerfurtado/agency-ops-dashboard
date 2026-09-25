using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace RelatoAI.DesktopAgent;

internal static class MeetingAudioMixer
{
    private const int VoiceSampleRate = 16000;
    private const int Mp3Bitrate = 48000;

    public static bool TryCreateMixedMp3(MeetingAudioOutboxItem item, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(item.MixedPath))
        {
            error = "mixed_path_missing";
            return false;
        }

        try
        {
            if (File.Exists(item.MixedPath) && new FileInfo(item.MixedPath).Length > 1000)
                return true;

            var sources = new List<string>();
            if (File.Exists(item.LocalPath) && new FileInfo(item.LocalPath).Length > 1000) sources.Add(item.LocalPath);
            if (File.Exists(item.RemotePath) && new FileInfo(item.RemotePath).Length > 1000) sources.Add(item.RemotePath);
            if (sources.Count == 0)
            {
                error = "no_source_wav";
                return false;
            }

            var dir = Path.GetDirectoryName(item.MixedPath)!;
            Directory.CreateDirectory(dir);
            var normalized = new List<string>();
            var tempMixed = Path.Combine(dir, "meeting-mix-temp.wav");

            try
            {
                for (var i = 0; i < sources.Count; i++)
                {
                    var normalizedPath = Path.Combine(dir, $"normalized-{i}.wav");
                    using var reader = new WaveFileReader(sources[i]);
                    using var resampler = new MediaFoundationResampler(reader, new WaveFormat(VoiceSampleRate, 16, 1))
                    {
                        ResamplerQuality = 60
                    };
                    WaveFileWriter.CreateWaveFile(normalizedPath, resampler);
                    normalized.Add(normalizedPath);
                }

                if (normalized.Count == 1)
                {
                    File.Copy(normalized[0], tempMixed, true);
                }
                else
                {
                    using var local = new AudioFileReader(normalized[0]);
                    using var remote = new AudioFileReader(normalized[1]);
                    var inputs = new ISampleProvider[]
                    {
                        new VolumeSampleProvider(local) { Volume = 0.72f },
                        new VolumeSampleProvider(remote) { Volume = 0.72f }
                    };
                    var mixer = new MixingSampleProvider(inputs) { ReadFully = false };
                    WaveFileWriter.CreateWaveFile16(tempMixed, mixer);
                }

                try
                {
                    if (File.Exists(item.MixedPath)) File.Delete(item.MixedPath);
                    using var mixedReader = new WaveFileReader(tempMixed);
                    MediaFoundationEncoder.EncodeToMp3(mixedReader, item.MixedPath, Mp3Bitrate);
                }
                catch
                {
                    if (File.Exists(item.MixedPath)) File.Delete(item.MixedPath);
                    using var mixedReader = new WaveFileReader(tempMixed);
                    MediaFoundationEncoder.EncodeToMp3(mixedReader, item.MixedPath, 64000);
                }

                if (!File.Exists(item.MixedPath) || new FileInfo(item.MixedPath).Length <= 1000)
                {
                    error = "mixed_mp3_empty";
                    return false;
                }
                return true;
            }
            finally
            {
                foreach (var path in normalized)
                {
                    try { if (File.Exists(path)) File.Delete(path); } catch { }
                }
                try { if (File.Exists(tempMixed)) File.Delete(tempMixed); } catch { }
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
            try { if (!string.IsNullOrWhiteSpace(item.MixedPath) && File.Exists(item.MixedPath)) File.Delete(item.MixedPath); } catch { }
            return false;
        }
    }
}
