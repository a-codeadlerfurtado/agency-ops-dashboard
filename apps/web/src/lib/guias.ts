import type { PassoDoGuia } from "../GuiaDeIntegracao";

/**
 * Conteúdo dos guias de integração.
 *
 * Separado do componente de propósito: mudar a redação de um passo ou trocar a
 * ordem é coisa que se faz com frequência, e não deve exigir abrir o código da
 * navegação. As imagens são referenciadas por caminho relativo a
 * `public/guias/` — soltar o PNG na pasta é o suficiente.
 */

const CURL_EXEMPLO = `curl -X POST "SUA_URL_DE_CALLBACK" \\
  -H "content-type: application/json" \\
  -d '{
    "nome": "Maria Souza",
    "telefone": "+5511999998888",
    "email": "maria@exemplo.com",
    "utm_source": "google",
    "utm_campaign": "lancamento-vista"
  }'`;

export const GUIAS: Record<string, PassoDoGuia[]> = {
  GOOGLE_ADS: [
    {
      titulo: "Abra o formulário de lead da campanha",
      texto:
        "No Google Ads, vá em Campanhas › Recursos › Formulário de lead. Se a campanha ainda não tem um, crie agora — o webhook só aparece depois que o formulário existe.",
      imagem: "google/passo-1.png",
    },
    {
      titulo: "Encontre 'Opções de entrega de leads'",
      texto:
        "Role até o fim do formulário. A seção fica depois das perguntas e da mensagem de agradecimento, e vem recolhida por padrão.",
      imagem: "google/passo-2.png",
    },
    {
      titulo: "Cole a URL e a Chave",
      texto:
        "Escolha Webhook. A URL vai no campo 'URL do webhook' e a Chave no campo 'Chave'. São os dois valores abaixo — a chave é o mesmo texto que aparece no fim da URL.",
      imagem: "google/passo-3.png",
      mostrarCredenciais: true,
    },
    {
      titulo: "Clique em 'Enviar dados de teste'",
      texto:
        "O Google só aceita a URL depois de receber resposta. Esse lead de teste NÃO entra no seu funil de propósito: ele existe apenas para validar a configuração.",
      imagem: "google/passo-4.png",
    },
    {
      titulo: "Salve e vincule ao anúncio",
      texto:
        "Salve o formulário e confirme que ele está associado ao anúncio ou à campanha. A partir daí o lead cai aqui no momento do envio, já distribuído para um corretor da fila.",
      imagem: "google/passo-5.png",
    },
  ],

  META_ADS: [
    {
      titulo: "Atribua a Página ao usuário de sistema",
      texto:
        "Em Configurações do Negócio › Usuários de sistema, selecione o usuário e clique em Adicionar ativos. Marque a PÁGINA — não basta a conta de anúncios; sem a página, o token não lê o formulário.",
      imagem: "meta/passo-1.png",
    },
    {
      titulo: "Copie o ID da página",
      texto:
        "Na página do Facebook, vá em Configurações › Informações. O ID é só número, e fica no rodapé dessa tela.",
      imagem: "meta/passo-2.png",
    },
    {
      titulo: "Cole o ID aqui no CRM",
      texto:
        "Em Integrações › Conectar pela Business Manager, cole o ID da página. O CRM busca o nome e o token dela sozinho, usando o usuário de sistema.",
      imagem: "meta/passo-3.png",
      mostrarCredenciais: true,
    },
    {
      titulo: "Escolha a fila de destino",
      texto:
        "É a fila que vai receber e distribuir esses leads. Sem fila com corretor ativo, o lead entra mas fica sem dono.",
      imagem: "meta/passo-4.png",
    },
    {
      titulo: "Envie um lead de teste",
      texto:
        "Use a Ferramenta de Teste de Anúncios de Cadastro da Meta. Atenção: ela passa mesmo sem o Acesso a Leads liberado para a BM — se o teste passar e o lead real não chegar, é esse acesso que falta.",
      imagem: "meta/passo-5.png",
    },
  ],

  SITE: [
    {
      titulo: "Copie a URL de callback",
      texto:
        "Ela é gerada no momento em que a conexão é criada e contém o token. Guarde agora: por segurança, ela não é exibida de novo.",
      imagem: "site/passo-1.png",
      mostrarCredenciais: true,
    },
    {
      titulo: "Faça o formulário enviar um POST",
      texto:
        `Qualquer linguagem serve; o corpo é JSON. Exemplo:\n\n${CURL_EXEMPLO}`,
      imagem: "site/passo-2.png",
    },
    {
      titulo: "Confira em Leads",
      texto:
        "O lead aparece em segundos, já distribuído. Se o envio falhar, a resposta diz o motivo: 401 é token errado, 422 é lead sem telefone e sem e-mail.",
      imagem: "site/passo-3.png",
    },
  ],

  WEBHOOK: [
    {
      titulo: "Copie a URL de callback",
      texto:
        "É o endereço que o Zapier, Make, n8n ou RD Station vai chamar. Ela contém o token e não é exibida de novo depois que você fechar a tela.",
      imagem: "webhook/passo-1.png",
      mostrarCredenciais: true,
    },
    {
      titulo: "Configure o passo de saída HTTP",
      texto:
        `Método POST, corpo JSON. Os nomes de campo aceitos são amplos — nome/name/full_name, telefone/phone/whatsapp, email — porque cada ferramenta repassa com um nome diferente. Exemplo:\n\n${CURL_EXEMPLO}`,
      imagem: "webhook/passo-2.png",
    },
    {
      titulo: "Dispare um teste pela própria ferramenta",
      texto:
        "Quase todas têm botão de teste. O lead entra de verdade — diferente do Google, aqui não há distinção de teste, então use um nome que você reconheça para apagar depois.",
      imagem: "webhook/passo-3.png",
    },
  ],
};
