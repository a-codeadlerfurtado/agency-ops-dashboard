FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "numpy>=1.26,<3" "opencv-contrib-python-headless>=4.10,<5" \
    && useradd -u 10001 -m worker && mkdir -p /data/work /data/music && chown -R worker:worker /data
WORKDIR /app
COPY worker.py worker_v42.py worker_v421.py worker_v43.py worker_v431.py director_v42.py director_v43.py vision_v43.py audio_v43.py capabilities_v43.py providers_v43.py qa_v43.py learning_v43.py variants_v43.py healthcheck.py smoke_raw.py /app/
USER 10001:10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 VIDEO_WORK_DIR=/data/work VIDEO_MUSIC_LIBRARY_DIR=/data/music
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD python /app/healthcheck.py
CMD ["python","/app/worker_v431.py"]
