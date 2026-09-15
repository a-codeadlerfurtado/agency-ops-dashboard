#!/usr/bin/env bash
# Sobe o OpsQuestion nesta VPS especifica, do jeito que ela ja' funciona.
#
#   sudo bash deploy-easypanel.sh
#
# POR QUE NAO E' O Caddyfile DESTE DIRETORIO
# A srv1837879 nao e' uma maquina vazia. Ela roda EasyPanel sobre Docker Swarm, e o
# Traefik do EasyPanel ja' ocupa as portas 80 e 443. Caddy nao consegue nem subir, e
# sem a porta 80 nao sai certificado Let's Encrypt. O Caddyfile continua no repo para
# quem instalar num servidor limpo; aqui ele nao se aplica.
#
# O caminho certo e' entrar no mesmo esquema que ja' serve o centralops-web:
# container na rede overlay 'easypanel', com labels de Traefik. O certificado vem do
# curinga *.yb4hto.easypanel.host que o EasyPanel ja' mantem - nada a provisionar.
#
# Node tambem nao esta' instalado na maquina, e nao precisa: roda dentro do
# node:22-alpine. Nada e' instalado no host alem deste container.

set -euo pipefail

NOME=opsquestion
DOMINIO="${OPSQUESTION_DOMAIN:-opsquestion.yb4hto.easypanel.host}"
PORTA=8787
REDE=easypanel
ENV_FILE=/etc/opsquestion.env
APP=/opt/opsquestion

[[ $EUID -eq 0 ]] || { echo "rode com sudo"; exit 1; }
[[ -f $APP/server.mjs ]] || { echo "erro: falta $APP/server.mjs (copie de vps/opsquestion/ do repo)"; exit 1; }
[[ -f $ENV_FILE ]] || { echo "erro: falta $ENV_FILE (copie de opsquestion.env.example e preencha)"; exit 1; }
docker network inspect "$REDE" >/dev/null 2>&1 || { echo "erro: rede docker '$REDE' nao existe - esta VPS mudou de estrutura"; exit 1; }

chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"

# Recriar e' o jeito de atualizar: o container nao guarda estado nenhum.
docker rm -f "$NOME" >/dev/null 2>&1 || true

# HOST=0.0.0.0 aqui e' seguro e necessario: dentro do container o loopback so' enxerga
# ele mesmo, e nenhuma porta e' publicada no host (-p ausente de proposito). Quem
# alcanca o servico e' o Traefik, pela rede overlay.
docker run -d --name "$NOME" \
  --restart unless-stopped \
  --network "$REDE" \
  --env-file "$ENV_FILE" \
  -e HOST=0.0.0.0 -e PORT="$PORTA" \
  -v "$APP/server.mjs:/app/server.mjs:ro" \
  --read-only --tmpfs /tmp \
  --label traefik.enable=true \
  --label traefik.docker.network="$REDE" \
  --label "traefik.http.routers.$NOME.rule=Host(\`$DOMINIO\`)" \
  --label "traefik.http.routers.$NOME.entrypoints=https" \
  --label "traefik.http.routers.$NOME.tls=true" \
  --label "traefik.http.routers.$NOME.priority=10" \
  --label "traefik.http.services.$NOME.loadbalancer.server.port=$PORTA" \
  node:22-alpine node /app/server.mjs

sleep 3
if ! docker ps --format '{{.Names}}' | grep -qx "$NOME"; then
  echo "· o container morreu ao subir. Motivo:"
  docker logs "$NOME" 2>&1 | tail -20
  exit 1
fi

echo "· container de pe'. Health por dentro da rede:"
docker run --rm --network "$REDE" curlimages/curl:latest -fsS "http://$NOME:$PORTA/health" || {
  echo "· nao respondeu. Log:"; docker logs "$NOME" 2>&1 | tail -20; exit 1; }
echo
echo "· externamente: https://$DOMINIO/health"
echo "  (se der 404, o Traefik ainda nao recarregou - espere ~10s e tente de novo)"
