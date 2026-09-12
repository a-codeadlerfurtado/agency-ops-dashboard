# Jarvis TTS proprio

Servidor de voz da Jarvis sem TTS pago por caractere. O Worker continua autenticando o usuario e encaminha somente o texto para esta API; o navegador mantem `speechSynthesis` como fallback.

## Motor e voz

- Chatterbox Multilingual V3 (`language_id="pt"`).
- Zero-shot voice cloning com um WAV de referencia local.
- A referencia atual foi preparada a partir de um dos exemplos da Jarvis enviados pelo Adler e fica em `reference/voice.wav`.
- `reference/` esta no `.gitignore`: a voz nao entra em commit, ZIP de codigo ou deploy por Git.

## Alvo inicial de GPU

O Dockerfile principal mira o Hetzner GEX44 / RTX 4000 SFF Ada. Ele usa PyTorch 2.6 + CUDA 12.4, que coincide com a dependencia fixada pelo `chatterbox-tts==0.1.7`.

Nao use este Dockerfile sem ajuste no GEX45 Blackwell. O GEX45 exige uma pilha CUDA/PyTorch com suporte a `sm_120` (CUDA 12.8+); isso deve ser validado separadamente antes do primeiro deploy nele.

## Arquitetura

Browser -> `/api/jarvis/tts` no Cloudflare Worker -> HTTPS -> esta API -> Chatterbox -> WAV -> Worker -> Browser.

A API escuta somente `127.0.0.1:8091` no host. Caddy publica HTTPS e faz reverse proxy. O endpoint `/tts` exige `x-jarvis-token`.

## Deploy no servidor

Prerequisitos no host Linux:

1. driver NVIDIA funcionando (`nvidia-smi`);
2. Docker Engine + Docker Compose v2;
3. NVIDIA Container Toolkit configurado para o Docker;
4. Caddy;
5. DNS apontando um hostname para o servidor (ou um hostname temporario que resolva para o IP).

Copie esta pasta inteira para `/opt/jarvis-tts`, incluindo manualmente `reference/voice.wav`. Depois:

```bash
cd /opt/jarvis-tts
cp .env.example .env
TOKEN="$(openssl rand -hex 32)"
sed -i "s/^JARVIS_TTS_TOKEN=.*/JARVIS_TTS_TOKEN=$TOKEN/" .env
docker compose up -d --build
curl -fsS http://127.0.0.1:8091/health
```

O primeiro start baixa os pesos e pode demorar varios minutos. O container so deve ser considerado pronto quando `/health` responder com `model_loaded: true`, `device: cuda` e `reference: true`.

## HTTPS

Copie `Caddyfile.example` para `/etc/caddy/Caddyfile`, defina `JARVIS_PUBLIC_HOST` no servico do Caddy (ou troque o placeholder pelo hostname real) e recarregue:

```bash
sudo systemctl reload caddy
```

O firewall publico deve permitir apenas SSH e HTTPS/HTTP para emissao/renovacao do certificado. A porta 8091 continua fechada externamente.

## Cloudflare Worker

Quando a URL HTTPS estiver pronta, configure no Worker:

- `JARVIS_TTS_URL=https://<host>`
- `JARVIS_TTS_TOKEN=<mesmo token do servidor>`

O token deve entrar como secret. Depois gere uma nova version preview e teste a Jarvis antes de qualquer deploy de producao.

## Smoke test direto

No proprio servidor:

```bash
curl -fsS http://127.0.0.1:8091/health
curl -fsS -X POST http://127.0.0.1:8091/tts \
  -H "content-type: application/json" \
  -H "x-jarvis-token: $TOKEN" \
  --data '{"text":"Bom dia, senhor. Central de operacoes online."}' \
  --output /tmp/jarvis.wav
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/jarvis.wav
```

## Parametros de naturalidade

Os valores iniciais ficam no `.env`:

- `EXAGGERATION=0.42`
- `CFG_WEIGHT=0.30`
- `TEMPERATURE=0.72`
- chunks de ate 280 caracteres

Eles foram deixados configuraveis para comparar amostras sem alterar codigo. O ajuste final deve ser feito ouvindo frases curtas e longas na propria voz de referencia.
