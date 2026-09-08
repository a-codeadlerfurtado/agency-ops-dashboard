# Alvo inicial: Hetzner GEX44 (RTX 4000 SFF Ada, sm_89).
# O Chatterbox 0.1.7 fixa torch/torchaudio 2.6.0; esta imagem ja entrega
# exatamente essa versao com CUDA 12.4, evitando cair sem querer em CPU.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ffmpeg libsndfile1 git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./app.py
RUN mkdir -p /app/reference /models/huggingface

EXPOSE 8091
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1"]
