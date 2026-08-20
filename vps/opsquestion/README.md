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

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
opsquestion.SEUDOMINIO.com.br {
	reverse_proxy 127.0.0.1:8787 {
		# uma pergunta pode levar até ~50s investigando o banco
		transport http {
			response_header_timeout 90s
		}
	}
}
```

```bash
sudo systemctl reload caddy
```

O Caddy tira certificado sozinho no primeiro acesso. Teste de fora:

```bash
curl -s https://opsquestion.SEUDOMINIO.com.br/health
```

## Virar a chave

Enquanto `AI_ASK_ENDPOINT_URL` não existir em `automation_settings`, a Edge Function
continua indo no Make — nada muda. A troca é um insert:

```sql
insert into agency_ops.automation_settings (key, value)
values ('AI_ASK_ENDPOINT_URL', '"https://opsquestion.SEUDOMINIO.com.br/opsquestion"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
```

A volta é apagar a linha. Não precisa de deploy em nenhuma das duas direções.

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

`MAKE_AI` é o caminho antigo, `DIRECT_AI` é esta VPS, `DIRECT_DB` são as perguntas que a
própria Edge Function responde sem IA nenhuma.

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
