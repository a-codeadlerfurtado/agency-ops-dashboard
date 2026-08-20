# OpsQuestion na VPS

Tira o Make do caminho da pergunta. Hoje o fluxo é

```
dashboard → agency-ops-ai-ask → webhook do Make → IA → SQL → Make → volta
```

e o Make, nesse trajeto, só repassa: não guarda estado, não decide nada, e consome
uma operação por pergunta. Depois desta troca:

```
dashboard → agency-ops-ai-ask → VPS (server.mjs) → Claude
                                      │
                                      └→ agency-ops-run-readonly-sql → Postgres
```

## O que a VPS pode e o que não pode

Quem executa SQL continua sendo a Edge Function `agency-ops-run-readonly-sql`, que já
existia e já era usada pelo cenário do Make. Ela valida a consulta (um comando só, sem
comentário, 35 palavras-chave banidas) e conecta com o papel `agency_ops_ai_reader`, que
tem `SELECT` e nada mais.

A VPS **não tem senha de banco** e **não abre conexão com o Postgres**. Se a máquina for
comprometida, o alcance é o mesmo de quem já podia digitar uma pergunta no dashboard.

## Pré-requisitos

- Node 18 ou mais novo (`node -v`)
- Um hostname apontando para a VPS — a Supabase precisa alcançar o serviço, e o segredo
  viaja em header, então **HTTP puro está fora de questão**
- A chave da Anthropic, gerada em console.anthropic.com

## Instalação

### O jeito curto

```bash
sudo bash instalar.sh
```

Ele confere o Node, cria o usuário, copia o código, instala o systemd unit e avisa o
que falta preencher. Rodar de novo é como se atualiza o código depois.

### O jeito longo, se preferir ver cada passo

```bash
# 1. usuário sem shell e sem home, só para rodar o serviço
sudo useradd --system --no-create-home --shell /usr/sbin/nologin opsquestion
sudo mkdir -p /opt/opsquestion

# 2. o código
sudo cp server.mjs /opt/opsquestion/server.mjs
sudo chown -R root:root /opt/opsquestion   # o serviço lê, não escreve

# 3. as chaves
sudo install -m 600 -o root -g root opsquestion.env.example /etc/opsquestion.env
sudo nano /etc/opsquestion.env             # preencher ANTHROPIC_API_KEY e AI_ASK_READ_SECRET

# 4. o serviço
sudo cp opsquestion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opsquestion
sudo systemctl status opsquestion
```

Confira que subiu:

```bash
curl -s localhost:8787/health
# {"ok":true,"service":"opsquestion","model":"claude-sonnet-5"}
```

## TLS

O `server.mjs` escuta só em `127.0.0.1`. Quem fala com a internet é o Caddy:

A VPS é a `srv1837879.hstgr.cloud` (179.197.228.160, KVM 2, Hostinger). Esse hostname
já resolve, então serve de domínio — não precisa comprar nem apontar nada.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

As portas 80 e 443 precisam estar abertas no firewall da Hostinger. Sem a 80, o
certificado nunca sai e o erro fica só no log do Caddy.

O `Caddyfile` deste diretório já vem com o hostname certo. Teste de fora:

```bash
curl -s https://srv1837879.hstgr.cloud/health
```

## Virar a chave

Enquanto `AI_ASK_ENDPOINT_URL` não existir em `automation_settings`, a Edge Function
continua indo no Make — nada muda. A troca é um insert:

```sql
insert into agency_ops.automation_settings (key, value)
values ('AI_ASK_ENDPOINT_URL', '"https://srv1837879.hstgr.cloud/opsquestion"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
```

A volta é apagar a linha. Não precisa de deploy em nenhuma das duas direções.

E a virada não é aposta: se a VPS falhar **rápido** — fora do ar, certificado vencido,
serviço reiniciando — a Edge Function repete a pergunta no Make e o time recebe a
resposta assim mesmo, com `source = DIRECT_AI_FALLBACK` no log. Falha **lenta** não tem
plano B: o tempo do usuário já foi gasto, e insistir só entregaria um timeout mais longo.
Então o pior caso de uma VPS mal configurada é uma linha no log, não uma equipe sem
OpsQuestion.

```sql
delete from agency_ops.automation_settings where key = 'AI_ASK_ENDPOINT_URL';
```

## Conferir que virou

`opsquestion_interactions.source` grava a rota real de cada pergunta:

```sql
select source, count(*), round(avg(latency_ms)/1000.0, 1) as seg, max(created_at)
from agency_ops.opsquestion_interactions
where created_at > now() - interval '1 day'
group by 1 order by 4 desc;
```

| `source` | o que aconteceu |
|---|---|
| `DIRECT_DB` | a própria Edge Function respondeu, sem IA nenhuma |
| `MAKE_AI` | caminho antigo, pelo cenário do Make |
| `DIRECT_AI` | esta VPS |
| `DIRECT_AI_FALLBACK` | a VPS falhou e o Make cobriu — **vá ver o journalctl** |

`DIRECT_AI_FALLBACK` aparecendo é o sinal de que algo na VPS está errado mesmo que
ninguém tenha reclamado: as respostas continuaram saindo.

## Quando algo quebra

```bash
sudo journalctl -u opsquestion -f
```

Cada pergunta escreve duas linhas: uma com passos, tempo e quantas consultas rodaram,
outra com o SQL que o modelo escreveu. A pergunta e as linhas do banco **não** vão para o
log — o que ajuda a diagnosticar é a consulta, o resto é dado de cliente.

| No log | O que é |
|---|---|
| `anthropic_http_401` | chave da Anthropic inválida ou ausente em `/etc/opsquestion.env` |
| `anthropic_http_429` | cota da Anthropic estourada |
| `empty_ai_answer` | o modelo gastou os 8 passos sem concluir — quase sempre pergunta ampla demais |
| `unauthorized` no acesso | `AI_ASK_READ_SECRET` da VPS diferente do que está em `automation_settings` |
| `vps_http_502` no dashboard | o serviço respondeu erro; a causa está no journalctl |
| `ai_timeout` no dashboard | passou de 60s — o teto da Edge Function, não deste serviço |

## Atualizar o código

```bash
sudo cp server.mjs /opt/opsquestion/server.mjs
sudo systemctl restart opsquestion
```
