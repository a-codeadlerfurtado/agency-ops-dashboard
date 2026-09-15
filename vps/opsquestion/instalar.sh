#!/usr/bin/env bash
# Instala o OpsQuestion na VPS. Roda de novo sem estragar nada: atualizar o codigo
# e' rodar este mesmo script.
#
#   sudo bash instalar.sh
#
# Nao pede, nao escreve e nao mostra chave nenhuma. As chaves vao em
# /etc/opsquestion.env, na mao, depois deste script avisar.

set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO=/opt/opsquestion
ENV_FILE=/etc/opsquestion.env

[[ $EUID -eq 0 ]] || { echo "rode com sudo"; exit 1; }

# --- Node -------------------------------------------------------------------
command -v node >/dev/null || { echo "erro: Node nao encontrado. Instale Node 18+ antes."; exit 1; }
MAIOR=$(node -p 'process.versions.node.split(".")[0]')
[[ $MAIOR -ge 18 ]] || { echo "erro: Node $(node -v) e' antigo demais. Precisa de 18+ (fetch e AbortSignal.timeout)."; exit 1; }
echo "· Node $(node -v)"

# --- usuario ----------------------------------------------------------------
if ! id opsquestion &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin opsquestion
  echo "· usuario opsquestion criado"
else
  echo "· usuario opsquestion ja' existia"
fi

# --- codigo -----------------------------------------------------------------
# Dono root, so' leitura para o servico: o processo nunca precisa se reescrever.
install -d -m 755 -o root -g root "$DESTINO"
install -m 644 -o root -g root "$AQUI/server.mjs" "$DESTINO/server.mjs"
echo "· server.mjs em $DESTINO"

# --- env --------------------------------------------------------------------
# So' cria o arquivo se nao existir. Sobrescrever aqui apagaria as chaves de quem
# ja' preencheu - e o proximo restart subiria sem chave, sem aviso.
if [[ ! -f $ENV_FILE ]]; then
  install -m 600 -o root -g root "$AQUI/opsquestion.env.example" "$ENV_FILE"
  PRECISA_CHAVE=1
else
  chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
  PRECISA_CHAVE=0
  grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE" || PRECISA_CHAVE=1
  grep -q '^AI_ASK_READ_SECRET=.\+' "$ENV_FILE" || PRECISA_CHAVE=1
fi

# --- servico ----------------------------------------------------------------
install -m 644 -o root -g root "$AQUI/opsquestion.service" /etc/systemd/system/opsquestion.service
systemctl daemon-reload
systemctl enable opsquestion >/dev/null 2>&1

if [[ $PRECISA_CHAVE -eq 1 ]]; then
  cat <<AVISO

  Falta preencher as chaves antes de subir:

      sudo nano $ENV_FILE

  ANTHROPIC_API_KEY  -> console.anthropic.com, API keys, Create key
  AI_ASK_READ_SECRET -> o valor que ja' existe no banco:
      select value #>> '{}' from agency_ops.automation_settings where key='AI_ASK_READ_SECRET';

  Depois:  sudo systemctl restart opsquestion && curl -s localhost:8787/health

AVISO
  exit 0
fi

systemctl restart opsquestion
sleep 2

if curl -fsS --max-time 5 localhost:"${PORT:-8787}"/health >/dev/null 2>&1; then
  echo
  curl -s localhost:"${PORT:-8787}"/health; echo
  echo "· servico de pe'."
  echo
  echo "  Falta so' o TLS (Caddy) e virar a chave no banco - os dois no README.md."
else
  echo
  echo "· o servico nao respondeu no /health. O motivo esta' em:"
  echo "      sudo journalctl -u opsquestion -n 30 --no-pager"
  exit 1
fi
