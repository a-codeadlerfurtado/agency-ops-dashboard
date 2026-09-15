/**
 * Conversa social basica, respondida sem tocar em nada.
 *
 * "ola tudo bem?" nao precisa de Supabase, snapshot, conversations/create,
 * prepare-chat, OpenAI, ferramenta, Meta nem WhatsApp. Quando o backend
 * operacional esta degradado, uma saudacao respondendo "Nao consegui consultar
 * agora" e' uma falha basica de produto: o assistente parece morto quando na
 * verdade so' a consulta pesada esta indisponivel.
 *
 * Roda ANTES de carregarClientesPermitidos, conversations/create e do modelo.
 */

function normalizar(texto: string): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Termos que denunciam pergunta operacional.
 *
 * A saudacao so' pode responder quando a mensagem e' PREDOMINANTEMENTE social.
 * "bom dia, quantos clientes ativos temos?" e' pergunta com educacao na frente,
 * nao cumprimento -- e roubar essa mensagem seria pior que o bug original.
 */
const SINAIS_OPERACIONAIS = [
  "cliente", "clientes", "saldo", "lead", "leads", "campanha", "campanhas",
  "gasto", "gastou", "recarga", "meta", "onboarding", "gt", "cs", "designer",
  "equipe", "time", "task", "tarefa", "demanda", "alerta", "contrato",
  "quantos", "quantas", "qual", "quais", "quem", "quanto", "cpl", "cpc",
  "relatorio", "material", "briefing", "reuniao", "capacidade", "churn",
];

/** Cumprimentos e frases de cortesia. */
const SAUDACOES = [
  "oi", "ola", "opa", "eai", "e ai", "salve", "hey", "hello",
  "bom dia", "boa tarde", "boa noite",
  "tudo bem", "tudo bom", "td bem", "beleza", "blz",
  "como voce esta", "como vc esta", "como esta", "como vai",
  "jarvis", "fala jarvis", "oi jarvis", "ola jarvis",
  "obrigado", "obrigada", "valeu", "vlw", "brigado",
  "bom te ver", "tudo certo",
];

/** Tamanho maximo, em palavras, para ainda ser considerado so' cortesia. */
const MAX_PALAVRAS = 6;

export function ehSaudacao(mensagem: string): boolean {
  const q = normalizar(mensagem);
  if (!q) return false;
  if (q.split(" ").length > MAX_PALAVRAS) return false;
  // Qualquer sinal operacional tira a mensagem daqui, mesmo curta.
  if (SINAIS_OPERACIONAIS.some((t) => new RegExp(`\\b${t}\\b`).test(q))) return false;

  // A mensagem precisa ser feita SO de pedacos de cortesia. Remove cada termo
  // conhecido e checa se sobrou conteudo -- assim "oi tudo bem" passa e
  // "oi, e o relatorio" nao.
  let resto = ` ${q} `;
  for (const termo of [...SAUDACOES].sort((a, b) => b.length - a.length)) {
    resto = resto.split(` ${termo} `).join(" ");
  }
  resto = resto.replace(/\b(e|ai|entao|ae|pra|para|voce|vc|ta|esta|com|de|o|a|os|as)\b/g, " ").replace(/\s+/g, " ").trim();
  return resto.length === 0;
}

const AGRADECIMENTOS = /\b(obrigad|valeu|vlw|brigad)/;

/**
 * Resposta curta e natural. Determinstica de proposito: mesma entrada, mesma
 * saida -- nada aqui merece uma chamada de modelo.
 */
export function respostaSaudacao(mensagem: string, pessoa?: string): string {
  const q = normalizar(mensagem);
  const nome = String(pessoa ?? "").trim().split(" ")[0];

  if (AGRADECIMENTOS.test(q)) return "Por nada. Precisando, é só chamar.";
  if (q.includes("bom dia")) return nome ? `Bom dia, ${nome}. Pode mandar.` : "Bom dia. Pode mandar.";
  if (q.includes("boa tarde")) return nome ? `Boa tarde, ${nome}. O que você precisa?` : "Boa tarde. O que você precisa?";
  if (q.includes("boa noite")) return nome ? `Boa noite, ${nome}. O que você precisa?` : "Boa noite. O que você precisa?";
  if (/\b(tudo bem|tudo bom|td bem|como (voce |vc )?(esta|vai)|beleza|blz)\b/.test(q)) {
    return "Tudo certo por aqui. O que você quer consultar?";
  }
  return nome ? `Oi, ${nome}. O que você precisa?` : "Oi. O que você precisa?";
}
