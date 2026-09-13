FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/* && useradd -u 10001 -m worker && mkdir -p /data/work && chown -R worker:worker /data
WORKDIR /app
COPY worker.py healthcheck.py smoke_raw.py /app/
USER 10001:10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 VIDEO_WORK_DIR=/data/work
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD python /app/healthcheck.py
CMD ["python","/app/worker.py"]
