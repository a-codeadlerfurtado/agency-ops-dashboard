/**
 * Checagem da conexão de uma página, antes de o primeiro lead real chegar.
 *
 * A Ferramenta de Teste da Meta passa em condições que um lead real não tem:
 * ela cria o lead no próprio contexto. Um lead de verdade precisa também que
 * a Página tenha acesso a leads liberado para a Business Manager. Sem isso a
 * integração parece pronta e falha na primeira captação — que é a pior hora
 * possível para descobrir.
 *
 * A sequência aqui é a mesma que um lead real percorre:
 *   1. a página existe e o token de sistema alcança ela;
 *   2. dá para listar os formulários de lead da página;
 *   3. dá para ler os leads de um formulário.
 *
 * O passo 3 é o que separa "configurado" de "funcionando": é ele que exige o
 * acesso a leads, e é o que costuma faltar.
 */

const GRAPH = "https://graph.facebook.com/v26.0";

export const LINK_ACESSO_A_LEADS = "https://business.facebook.com/settings/leads_accesses";

export interface PassoDaChecagem {
  passo: string;
  ok: boolean;
  detalhe?: string;
}

export interface ResultadoDaChecagem {
  ok: boolean;
  passos: PassoDaChecagem[];
  /** mensagem pronta para mostrar; null quando esta tudo certo */
  acao: string | null;
  page_name?: string;
}

interface ErroDaGraph {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

/**
 * A Meta nao tem um codigo unico para "falta acesso a leads". Ela devolve
 * 190/10/200/(#100) conforme o caminho, e o texto e o unico sinal estavel.
 * Preferimos falso positivo a falso negativo: mandar conferir o Gerenciador
 * de Acesso a Leads e barato, descobrir na primeira captacao nao e.
 */
function pareceFaltaDeAcessoALeads(e?: ErroDaGraph): boolean {
  if (!e) return false;
  const t = `${e.message ?? ""}`.toLowerCase();
  return (
    t.includes("leads_retrieval") ||
    t.includes("lead retrieval") ||
    t.includes("leads access") ||
    t.includes("pages_manage_ads") ||
    t.includes("permission") ||
    t.includes("does not exist") ||
    e.code === 190 || e.code === 200 || e.code === 10 || e.code === 100
  );
}

async function pedir(url: string): Promise<{ ok: boolean; corpo: Record<string, unknown> }> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const corpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, corpo };
}

export async function checarPagina(
  pageId: string,
  tokenDeSistema: string
): Promise<ResultadoDaChecagem> {
  const passos: PassoDaChecagem[] = [];
  const liberar =
    `Liberar a BM - LAK no Gerenciador de Acesso a Leads dessa pagina: ${LINK_ACESSO_A_LEADS}`;

  // 1. a pagina e alcancavel pelo token de sistema, e devolve token proprio
  const p1 = await pedir(
    `${GRAPH}/${encodeURIComponent(pageId)}?fields=id,name,access_token` +
    `&access_token=${encodeURIComponent(tokenDeSistema)}`
  );
  const erro1 = p1.corpo.error as ErroDaGraph | undefined;
  const tokenDaPagina = p1.corpo.access_token as string | undefined;
  const nome = p1.corpo.name as string | undefined;

  if (!p1.ok || !tokenDaPagina) {
    passos.push({
      passo: "Acessar a pagina",
      ok: false,
      detalhe: erro1?.message ?? "A Meta nao devolveu token de acesso da pagina.",
    });
    return {
      ok: false,
      passos,
      acao:
        "Pagina nao esta atribuida ao usuario de sistema na BM, ou foi atribuida " +
        "apenas a conta de anuncios. Em Configuracoes do Negocio > Usuarios de " +
        "sistema, atribua a PAGINA e gere o token de novo.",
    };
  }
  passos.push({ passo: "Acessar a pagina", ok: true, detalhe: nome });

  // 2. listar os formularios de lead
  const p2 = await pedir(
    `${GRAPH}/${encodeURIComponent(pageId)}/leadgen_forms?limit=1` +
    `&access_token=${encodeURIComponent(tokenDaPagina)}`
  );
  const erro2 = p2.corpo.error as ErroDaGraph | undefined;
  const forms = (p2.corpo.data as { id?: string; name?: string }[] | undefined) ?? [];

  if (!p2.ok) {
    passos.push({ passo: "Listar formularios", ok: false, detalhe: erro2?.message });
    return {
      ok: false, passos, page_name: nome,
      acao: pareceFaltaDeAcessoALeads(erro2) ? liberar : (erro2?.message ?? "Falha ao listar formularios."),
    };
  }
  if (forms.length === 0) {
    passos.push({
      passo: "Listar formularios", ok: true,
      detalhe: "nenhum formulario nesta pagina",
    });
    return {
      ok: false, passos, page_name: nome,
      acao:
        "A pagina nao tem formulario de lead. Crie um em Ferramentas > " +
        "Formularios instantaneos antes de anunciar -- sem formulario nao ha " +
        "o que receber.",
    };
  }
  passos.push({ passo: "Listar formularios", ok: true, detalhe: forms[0]?.name ?? forms[0]?.id });

  // 3. ler leads do formulario -- e este que exige acesso a leads
  const p3 = await pedir(
    `${GRAPH}/${encodeURIComponent(forms[0]!.id!)}/leads?limit=1` +
    `&access_token=${encodeURIComponent(tokenDaPagina)}`
  );
  const erro3 = p3.corpo.error as ErroDaGraph | undefined;

  if (!p3.ok) {
    passos.push({ passo: "Ler leads do formulario", ok: false, detalhe: erro3?.message });
    return {
      ok: false, passos, page_name: nome,
      acao: pareceFaltaDeAcessoALeads(erro3) ? liberar : (erro3?.message ?? "Falha ao ler leads."),
    };
  }

  const quantos = ((p3.corpo.data as unknown[] | undefined) ?? []).length;
  passos.push({
    passo: "Ler leads do formulario",
    ok: true,
    detalhe: quantos > 0 ? "leitura autorizada, ha leads" : "leitura autorizada, sem leads ainda",
  });

  return { ok: true, passos, acao: null, page_name: nome };
}
