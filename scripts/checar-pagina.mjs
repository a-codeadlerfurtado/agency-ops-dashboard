#!/usr/bin/env node
/**
 * Checagem pré-onboarding de uma página do Facebook.
 *
 *   node scripts/checar-pagina.mjs <page_id> [slug-da-imobiliaria]
 *
 * Roda ANTES de conectar a página no CRM, para descobrir no terminal o que
 * de outra forma só apareceria na primeira captação real.
 *
 * A Ferramenta de Teste da Meta não serve como prova: ela cria o lead no
 * próprio contexto e passa mesmo sem o acesso a leads estar liberado. Um lead
 * de verdade percorre três etapas, e é a terceira que costuma faltar:
 *
 *   1. GET /{page_id}?fields=id,name,access_token   (token de sistema)
 *   2. GET /{page_id}/leadgen_forms?limit=1         (token da página)
 *   3. GET /{form_id}/leads?limit=1                 (token da página)
 *
 * Precisa das credenciais do Supabase no ambiente, porque lê o token de
 * sistema que já está guardado — nada de token em linha de comando, que
 * ficaria no histórico do shell:
 *
 *   SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...
 */

const GRAPH = "https://graph.facebook.com/v26.0";
const LINK = "https://business.facebook.com/settings/leads_accesses";

const [pageId, slug = "terra-concreta"] = process.argv.slice(2);

if (!pageId) {
  console.error("uso: node scripts/checar-pagina.mjs <page_id> [slug-da-imobiliaria]");
  process.exit(2);
}
if (!/^\d{5,25}$/.test(pageId)) {
  console.error("O ID da página é só número. Você encontra em Configurações da Página > Sobre.");
  process.exit(2);
}

const URL_SUPABASE = process.env.SUPABASE_URL;
const CHAVE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_SUPABASE || !CHAVE) {
  console.error(
    "Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.\n" +
    "No PowerShell:  $env:SUPABASE_URL=\"...\"; $env:SUPABASE_SERVICE_ROLE_KEY=\"...\""
  );
  process.exit(2);
}

const cor = {
  ok:    (t) => `\x1b[32m${t}\x1b[0m`,
  ruim:  (t) => `\x1b[31m${t}\x1b[0m`,
  fraco: (t) => `\x1b[90m${t}\x1b[0m`,
  forte: (t) => `\x1b[1m${t}\x1b[0m`,
};

async function rpc(funcao, args) {
  const r = await fetch(`${URL_SUPABASE}/rest/v1/rpc/${funcao}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "imobi_board",
      apikey: CHAVE,
      Authorization: `Bearer ${CHAVE}`,
    },
    body: JSON.stringify(args),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`Supabase respondeu ${r.status}: ${texto}`);
  return texto ? JSON.parse(texto) : null;
}

async function graph(caminho, token) {
  const sep = caminho.includes("?") ? "&" : "?";
  const r = await fetch(`${GRAPH}/${caminho}${sep}access_token=${encodeURIComponent(token)}`, {
    headers: { accept: "application/json" },
  });
  const corpo = await r.json().catch(() => ({}));
  return { ok: r.ok, corpo, erro: corpo?.error };
}

/* A Meta não tem código único para "falta acesso a leads": devolve 190, 200,
   10 ou 100 conforme o caminho, e o texto é o único sinal estável. Preferimos
   falso positivo — mandar conferir é barato, descobrir na captação não é. */
const pareceAcessoALeads = (e) => {
  if (!e) return false;
  const t = String(e.message ?? "").toLowerCase();
  return (
    t.includes("leads_retrieval") || t.includes("lead retrieval") ||
    t.includes("leads access") || t.includes("pages_manage_ads") ||
    t.includes("permission") || t.includes("does not exist") ||
    [190, 200, 10, 100].includes(e.code)
  );
};

function liberarAcesso() {
  console.log("");
  console.log(cor.forte("  Liberar a BM - LAK no Gerenciador de Acesso a Leads dessa página"));
  console.log("  " + LINK);
  console.log("");
  console.log(cor.fraco("  Lá: encontre a página, abra 'Acesso a leads' e adicione a BM - LAK."));
  console.log(cor.fraco("  Se a página for de um cliente, quem faz isso é o administrador dela."));
}

const passo = (n, texto, ok, detalhe) => {
  const marca = ok ? cor.ok("ok  ") : cor.ruim("falha");
  console.log(`  ${n}. ${marca}  ${texto}${detalhe ? cor.fraco("  — " + detalhe) : ""}`);
};

async function main() {
  console.log("");
  console.log(cor.forte(`Checando a página ${pageId}`) + cor.fraco(`  (imobiliária: ${slug})`));
  console.log("");

  const token = await rpc("token_de_sistema_do_tenant", { p_slug: slug });
  if (!token) {
    console.log(cor.ruim("  Nenhum token de sistema salvo para essa imobiliária."));
    console.log(cor.fraco("  Salve o token em Integrações > Conectar pela Business Manager."));
    process.exit(1);
  }

  // 1. a página responde e devolve token próprio
  const p1 = await graph(`${pageId}?fields=id,name,access_token`, token);
  const tokenDaPagina = p1.corpo?.access_token;
  if (!p1.ok || !tokenDaPagina) {
    passo(1, "Acessar a página", false, p1.erro?.message ?? "sem token de acesso da página");
    console.log("");
    console.log(cor.forte("  Página não está atribuída ao usuário de sistema na BM."));
    console.log(cor.fraco("  Configurações do Negócio > Usuários de sistema > atribuir a PÁGINA"));
    console.log(cor.fraco("  (não apenas a conta de anúncios) e gerar o token de novo."));
    process.exit(1);
  }
  passo(1, "Acessar a página", true, p1.corpo.name);

  // 2. formulários de lead
  const p2 = await graph(`${pageId}/leadgen_forms?limit=1`, tokenDaPagina);
  if (!p2.ok) {
    passo(2, "Listar formulários", false, p2.erro?.message);
    if (pareceAcessoALeads(p2.erro)) liberarAcesso();
    process.exit(1);
  }
  const forms = p2.corpo?.data ?? [];
  if (forms.length === 0) {
    passo(2, "Listar formulários", true, "nenhum formulário nesta página");
    console.log("");
    console.log(cor.forte("  A página não tem formulário de lead."));
    console.log(cor.fraco("  Crie em Ferramentas > Formulários instantâneos antes de anunciar."));
    process.exit(1);
  }
  passo(2, "Listar formulários", true, forms[0].name ?? forms[0].id);

  // 3. ler leads — é este passo que exige o acesso a leads
  const p3 = await graph(`${forms[0].id}/leads?limit=1`, tokenDaPagina);
  if (!p3.ok) {
    passo(3, "Ler leads do formulário", false, p3.erro?.message);
    if (pareceAcessoALeads(p3.erro)) liberarAcesso();
    process.exit(1);
  }
  const quantos = (p3.corpo?.data ?? []).length;
  passo(3, "Ler leads do formulário", true,
    quantos > 0 ? "leitura autorizada, há leads" : "leitura autorizada, sem leads ainda");

  console.log("");
  console.log(cor.ok("  Pronta para receber lead real."));
  console.log("");
}

main().catch((e) => {
  console.error("");
  console.error(cor.ruim("  " + (e?.message ?? String(e))));
  console.error("");
  process.exit(1);
});
