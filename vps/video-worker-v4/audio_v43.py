from __future__ import annotations

import array
import math
import os
import tempfile
import wave
from pathlib import Path

AUDIO_VERSION = "audio-v4.3.0"


def _rms(buf):
    if not buf:
        return 0.0
    return math.sqrt(sum(float(x) * float(x) for x in buf) / len(buf))


def analyze_music(ffmpeg_bin: str, path: str, max_seconds: float = 90.0):
    src = Path(path)
    if not src.exists():
        return {"version": AUDIO_VERSION, "available": False}
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        import subprocess
        cmd = [
            ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src), "-t", str(max_seconds), "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", wav_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=180)
        with wave.open(wav_path, "rb") as wf:
            rate = wf.getframerate()
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            if channels != 1 or width != 2:
                return {"version": AUDIO_VERSION, "available": False}
            raw = wf.readframes(wf.getnframes())
        samples = array.array("h")
        samples.frombytes(raw)
        hop = max(256, int(rate * 0.02))
        win = max(hop, int(rate * 0.08))
        envelope = []
        t = []
        for i in range(0, max(0, len(samples) - win), hop):
            envelope.append(_rms(samples[i:i+win]))
            t.append(i / rate)
        if len(envelope) < 8:
            return {"version": AUDIO_VERSION, "available": False}
        diffs = [0.0]
        for i in range(1, len(envelope)):
            diffs.append(max(0.0, envelope[i] - envelope[i-1]))
        vals = sorted(diffs)
        threshold = vals[int(len(vals) * 0.88)] if vals else 0.0
        peaks = []
        last = -10.0
        for i in range(1, len(diffs)-1):
            if diffs[i] >= threshold and diffs[i] >= diffs[i-1] and diffs[i] >= diffs[i+1]:
                ti = t[i]
                if ti - last >= 0.24:
                    peaks.append(round(ti, 3))
                    last = ti
        intervals = [peaks[i] - peaks[i-1] for i in range(1, len(peaks)) if 0.25 <= peaks[i] - peaks[i-1] <= 1.6]
        bpm = None
        if intervals:
            intervals.sort()
            med = intervals[len(intervals)//2]
            bpm = 60.0 / med if med > 0 else None
            while bpm and bpm < 70:
                bpm *= 2
            while bpm and bpm > 180:
                bpm /= 2
        duration = len(samples) / rate
        return {
            "version": AUDIO_VERSION,
            "available": True,
            "duration": round(duration, 3),
            "bpm": round(bpm, 2) if bpm else None,
            "beats": peaks[:400],
            "energy_mean": round(sum(envelope) / len(envelope), 2),
            "energy_peak": round(max(envelope), 2),
        }
    except Exception as e:
        return {"version": AUDIO_VERSION, "available": False, "error": str(e)[:300]}
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def nearest_beat(beats, t, radius=0.18):
    if not beats:
        return t
    best = min(beats, key=lambda b: abs(float(b) - float(t)))
    return float(best) if abs(float(best) - float(t)) <= radius else float(t)
