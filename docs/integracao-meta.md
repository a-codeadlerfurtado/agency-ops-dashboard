# Conectar a Meta

Tudo aqui é ação sua: criar o aplicativo aceita os Termos de Plataforma da
Meta e a Verificação de Negócio usa documento da empresa. O código do lado do
Imobi-Board já está pronto e esperando — este documento existe para você não
ter que adivinhar nenhum valor.

## Valores desta instalação

Copie daqui. Já estão no formato que a Meta pede.

| Onde a Meta pede | Valor |
|---|---|
| URI de redirecionamento do OAuth | `https://imobi-board-worker.lakassessoriadigital.workers.dev/v1/meta/oauth` |
| URL de callback do webhook | `https://imobi-board-worker.lakassessoriadigital.workers.dev/v1/meta/webhook` |
| Campo do webhook a assinar | `leadgen` (objeto **Página**) |
| Token de verificação | você escolhe; o mesmo valor vai em `META_VERIFY_TOKEN` |
| Domínio do app / URL do site | `https://imobi-board-app.lakassessoriadigital.workers.dev` |
| Permissões | `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `ads_management` |

## Caminho curto (o que serve hoje)

Não depende de App Review. Serve para imobiliária cujas páginas já estão na
sua Business Manager.

1. **Criar o aplicativo** em `developers.facebook.com` → tipo **Empresa**.
   Anote o **ID do aplicativo** (é público) e o **Chave Secreta** (é segredo).
2. **Vincular o app à BM**: Configurações do Negócio → Contas → Aplicativos →
   adicionar o app criado. Sem isso o usuário de sistema não recebe papel no
   app, e é o papel que dispensa o App Review.
3. **Criar o usuário de sistema**: Configurações do Negócio → Usuários →
   Usuários de sistema → Adicionar, função **Administrador**.
4. **Atribuir os ativos**: para cada cliente, atribua ao usuário de sistema a
   **Página** e a conta de anúncios.
   Só a conta de anúncios não basta — é o erro que faz o token listar zero
   páginas sem dizer por quê.
5. **Gerar o token**: no usuário de sistema → Gerar novo token → escolha o
   aplicativo → marque as cinco permissões da tabela acima.
   Token de usuário de sistema **não expira**.
6. **Webhook**: no painel do app → Webhooks → objeto **Página** → cole a URL de
   callback e o token de verificação → assine `leadgen`.
7. **Acesso a leads**: se o cliente restringiu, ele precisa liberar sua BM no
   **Gerenciador de Acesso a Leads** da página dele.

Depois disso, no CRM: Integrações → *Conectar pela Business Manager* → cole o
token → escolha a página → pronto. O lead passa a cair na fila em segundos.

## Caminho longo (para cliente que não é da sua BM)

Aí a imobiliária se conecta sozinha pelo botão *Conectar conta do Facebook*, e
esse caminho **exige** App Review da permissão `leads_retrieval`, além da
Verificação de Negócio. O código já está pronto; é a Meta que precisa aprovar.

## O que vai onde

O que é segredo nunca passa por mim nem pelo bundle do frontend.

| Valor | Onde entra | Quem coloca |
|---|---|---|
| ID do aplicativo | `VITE_META_APP_ID` no `.env` do web | público — pode me passar |
| Chave secreta do app | `wrangler secret put META_APP_SECRET` | você, no terminal |
| Token de verificação | `wrangler secret put META_VERIFY_TOKEN` | você, no terminal |
| Token de usuário de sistema | campo na tela de Integrações | você, no CRM |
| Chave de serviço do Supabase | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` | você, no terminal |

Os `wrangler secret put` rodam dentro de `workers/api`.

## Ordem que importa

`SUPABASE_SERVICE_ROLE_KEY` vem primeiro. Sem ela o worker não fala com o
banco, e nada do resto funciona — nem o handshake do webhook, nem a
importação de páginas, nem a entrada de lead.

## Como saber se funcionou

- `GET /health` no worker responde `ok`.
- Na tela de Integrações, a conexão sai de *Falta o token da página* para
  *Aguardando o primeiro lead*.
- Na Ferramenta de Teste de Lead Ads da Meta, envie um lead: ele aparece em
  **Leads** em segundos, já com corretor e prazo.
- Se falhar, o motivo fica escrito na própria conexão (`last_error`), não só
  no log.
