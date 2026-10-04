FROM node:22-bookworm-slim AS claude_cli
RUN npm install -g @anthropic-ai/claude-code@2.1.288 \
    && node --version \
    && claude --version

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "numpy>=1.26,<3" "opencv-contrib-python-headless>=4.10,<5" \
    && useradd -u 10001 -m worker \
    && mkdir -p /data/work /data/music /data/claude-config /usr/local/lib/node_modules/@anthropic-ai \
    && chown -R worker:worker /data
COPY --from=claude_cli /usr/local/bin/node /usr/local/bin/node
COPY --from=claude_cli /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
RUN ln -sf /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js /usr/local/bin/claude \
    && chmod +x /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js \
    && node --version \
    && claude --version
WORKDIR /app
COPY worker.py worker_v42.py worker_v421.py worker_v43.py worker_v431.py worker_v44.py worker_v45.py worker_v46.py director_v42.py director_v43.py vision_v43.py audio_v43.py capabilities_v43.py providers_v43.py vfx_local_v44.py qa_v43.py learning_v43.py variants_v43.py dna_v45.py critic_v45.py claude_edit_spec_v46.py claude_brain_v46.py healthcheck.py smoke_raw.py smoke_v45.py smoke_v46.py /app/
RUN python -m py_compile /app/*.py && python /app/smoke_v45.py && python /app/smoke_v46.py
USER 10001:10001
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VIDEO_WORK_DIR=/data/work \
    VIDEO_MUSIC_LIBRARY_DIR=/data/music \
    VIDEO_SERIF_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf \
    CLAUDE_CONFIG_DIR=/data/claude-config \
    VIDEO_CLAUDE_ENABLED=false \
    VIDEO_CLAUDE_VARIANT_FILTER=v4_claude_test \
    VIDEO_CLAUDE_FAIL_OPEN=false \
    VIDEO_CLAUDE_REQUIRE_MAX=true
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD python /app/healthcheck.py
CMD ["python","/app/worker_v46.py"]
