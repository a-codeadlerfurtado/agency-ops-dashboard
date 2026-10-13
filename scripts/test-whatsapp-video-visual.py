import importlib.util
import io
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).parent
WORKER = ROOT / 'video_visual_worker.py'
if not WORKER.exists():
    WORKER = ROOT.parent / 'vps' / 'whatsapp-video-visual' / 'worker.py'

class VideoVisualTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        token = pathlib.Path(cls.temp.name) / 'token'
        token.write_text('test-token')
        os.environ['MEDIA_VIDEO_API_URL'] = 'https://invalid.example'
        os.environ['MEDIA_VIDEO_TOKEN_FILE'] = str(token)
        spec = importlib.util.spec_from_file_location('media_visual_test_worker', WORKER)
        cls.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.worker)
        cls.samples = {}
        for audio in (False, True):
            path = pathlib.Path(cls.temp.name) / ('audio.mp4' if audio else 'silent.mp4')
            cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=2:duration=2']
            if audio:
                cmd += ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-shortest']
            cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', str(path)]
            subprocess.run(cmd, check=True)
            cls.samples[audio] = path.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def extract(self, audio, has_transcript=False):
        job = {'url': 'https://bfzdetibfcwihfkltbkp.supabase.co/storage/v1/object/sign/whatsapp-client-media/sample.mp4', 'has_transcript': has_transcript}
        with patch.object(self.worker.urllib.request, 'urlopen', return_value=io.BytesIO(self.samples[audio])):
            return self.worker.extract(job)

    def test_silent_video_has_visual_frames(self):
        result = self.extract(False)
        self.assertEqual(len(result['frames']), 2)
        self.assertIsNone(result['audio_base64'])
        self.assertTrue(all(0 < f['timestamp_seconds'] < result['duration_seconds'] for f in result['frames']))

    def test_video_with_audio_extracts_mp3(self):
        result = self.extract(True)
        self.assertGreater(len(result['audio_base64']), 100)
        self.assertEqual(len(result['frames']), 2)

    def test_existing_transcript_skips_retranscription(self):
        self.assertIsNone(self.extract(True, True)['audio_base64'])

    def test_untrusted_url_rejected_before_download(self):
        with patch.object(self.worker.urllib.request, 'urlopen') as download:
            with self.assertRaisesRegex(RuntimeError, 'invalid_storage_url'):
                self.worker.extract({'url': 'http://169.254.169.254/metadata'})
            download.assert_not_called()

    def test_oversized_download_rejected(self):
        with patch.object(self.worker, 'LIMIT', 10):
            with self.assertRaisesRegex(RuntimeError, 'media_payload_too_large'):
                self.extract(False)

if __name__ == '__main__':
    unittest.main()
