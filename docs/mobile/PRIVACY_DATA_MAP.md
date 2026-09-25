# ImobiBoard — mapa de dados para Play Data Safety / App Privacy

Baseado no comportamento atual do produto em 25/09/2026. Revisar novamente antes da submissão caso novas integrações sejam adicionadas.

## Dados tratados pelo CRM
- Nome: identificação e atendimento do lead.
- Telefone: contato comercial / WhatsApp.
- E-mail: contato e identificação.
- Respostas de formulário: qualificação e interesse imobiliário.
- Campanha, conjunto, anúncio e formulário de origem: atribuição de marketing.
- Data/hora e histórico de atividade: operação, atendimento e auditoria.
- Imóveis, visitas, propostas e vendas: execução do CRM.

## Dados do usuário do aplicativo
- Identificador da conta Supabase.
- E-mail/nome do usuário autenticado.
- Tenant ao qual o usuário pertence.
- Papel/função (admin/corretor).
- Token de push do aparelho, plataforma e versão do app.

## Recursos do aparelho
### Biometria
A biometria é validada pelo sistema operacional. O ImobiBoard não recebe impressão digital, Face ID nem template biométrico. O app grava apenas a preferência local de ativar/desativar o bloqueio biométrico.

### Câmera / fotos
Acessadas somente quando o usuário escolhe adicionar mídia. Não há coleta contínua. As fotos selecionadas/enviadas passam a integrar o conteúdo da imobiliária no CRM.

### Push
O token de push é vinculado ao usuário e tenant. Serve somente para notificações operacionais autorizadas, como novo lead. Memberships internas de Master não são inscritas automaticamente em push de clientes.

## Finalidades
- funcionalidade do aplicativo;
- autenticação e segurança;
- comunicação operacional;
- atendimento ao lead;
- analytics operacionais do próprio CRM;
- prevenção de fraude/auditoria.

## Compartilhamento
Infraestrutura utilizada atualmente:
- Supabase: banco, autenticação e storage;
- Cloudflare: aplicação/API;
- Meta: fonte de leads quando conectada;
- Firebase Cloud Messaging: entrega técnica de push Android, quando configurado;
- Apple Push Notification service: entrega técnica de push iOS, quando configurado.

Não marcar "venda de dados". O produto não vende dados pessoais.

## Segurança
- autenticação Supabase;
- sessão móvel armazenada em storage seguro nativo;
- RLS no schema imobi_board;
- isolamento por tenant;
- secrets de backend não entram no bundle;
- deep links apenas escolhem destino; o dado continua sujeito à autorização/RLS no backend.

## Exclusão
Solicitações de titular: leonardoimobiia@gmail.com.
A política pública do produto descreve direitos e fluxo de exclusão.
