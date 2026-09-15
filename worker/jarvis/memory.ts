/** Resolucao deterministica de entidades para memoria conversacional da Jarvis. */

export type ClientePermitido = {
  client_id: string;
  display_name: string;
  lifecycle?: string;
  gt_owner?: string | null;
  cs_owner?: string | null;
  designer_owner?: string | null;
};

export function normalizarEntidade(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function perguntaSobreOnboarding(mensagem: string): boolean {
  const q = normalizarEntidade(mensagem);
  return /\b(onboarding|onboard|onboardg|onbording|onbordem|ombording|ombordem|borden|boarding)\b/.test(q)
    || /\bon\s+(?:board|bord)(?:ing)?\b/.test(q);
}

/**
 * ATIVO OPERACIONAL = ACTIVE ou ONBOARDING.
 *
 * Regra de negocio da operacao, nao do banco: quem esta em onboarding JA E'
 * cliente -- contrato ativo, apenas ainda na implantacao. Responder 82 quando
 * ha 92 clientes sendo atendidos e' errado para quem toca a operacao.
 *
 * O lifecycle no banco continua distinguindo ACTIVE, ONBOARDING, CHURNED e
 * PROSPECT. A mudanca e' semantica, e mora SO aqui: qualquer contagem ou lista
 * do Jarvis passa por esta funcao, para a regra nao voltar a divergir entre
 * arquivos.
 */
export function ehAtivoOperacional(lifecycle: unknown): boolean {
  const v = String(lifecycle ?? "").toUpperCase();
  return v === "ACTIVE" || v === "ONBOARDING";
}

/** Somente ONBOARDING -- para "quantos estao em onboarding?". */
export function ehOnboarding(lifecycle: unknown): boolean {
  return String(lifecycle ?? "").toUpperCase() === "ONBOARDING";
}

/** Somente ACTIVE -- para "quantos ja sairam do onboarding?". */
export function ehEmOperacao(lifecycle: unknown): boolean {
  return String(lifecycle ?? "").toUpperCase() === "ACTIVE";
}

/** Quebra a carteira nas tres leituras de uma vez. */
export function repartirPorEstagio(clientes: ClientePermitido[]): { ativos: number; emOperacao: number; onboarding: number } {
  let emOperacao = 0, onboarding = 0;
  for (const c of clientes) {
    if (ehEmOperacao(c.lifecycle)) emOperacao += 1;
    else if (ehOnboarding(c.lifecycle)) onboarding += 1;
  }
  return { ativos: emOperacao + onboarding, emOperacao, onboarding };
}

export function contarClientesAtivos(clientes: ClientePermitido[]): number {
  return clientes.filter((c) => ehAtivoOperacional(c.lifecycle)).length;
}

export function resolverResponsavelMencionado(termo: string, clientes: ClientePermitido[]): string | null {
  const alvo = normalizarEntidade(termo);
  if (!alvo) return null;
  const nomes = new Set<string>();
  for (const c of clientes) {
    for (const nome of [c.gt_owner, c.cs_owner, c.designer_owner]) if (nome) nomes.add(String(nome));
  }
  const lista = [...nomes];
  const exatos = lista.filter((nome) => normalizarEntidade(nome) === alvo);
  if (exatos.length === 1) return exatos[0];
  const parciais = lista.filter((nome) => {
    const n = normalizarEntidade(nome);
    return n.startsWith(`${alvo} `) || n.split(" ").includes(alvo);
  });
  return parciais.length === 1 ? parciais[0] : null;
}

export function listarClientesAtivosPorResponsavel(clientes: ClientePermitido[], pessoa: string): ClientePermitido[] {
  const alvo = normalizarEntidade(pessoa);
  return clientes.filter((c) => ehAtivoOperacional(c.lifecycle) &&
    [c.gt_owner, c.cs_owner, c.designer_owner].some((nome) => normalizarEntidade(nome) === alvo));
}

export function contarClientesAtivosPorResponsavel(clientes: ClientePermitido[], pessoa: string): number {
  return listarClientesAtivosPorResponsavel(clientes, pessoa).length;
}

function distanciaEdicao(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(
        atual[j - 1] + 1,
        anterior[j] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    anterior = atual;
  }
  return anterior[b.length];
}

export function resolverClienteMencionado(mensagem: string, clientes: ClientePermitido[]): ClientePermitido | null {
  const q = normalizarEntidade(mensagem);
  if (!q || !clientes.length) return null;
  const qTokens = new Set(q.split(" ").filter(Boolean));
  const frequencia = new Map<string, number>();
  for (const c of clientes) {
    for (const t of new Set(normalizarEntidade(c.display_name).split(" ").filter((x) => x.length >= 4))) {
      frequencia.set(t, (frequencia.get(t) ?? 0) + 1);
    }
  }

  let melhor: ClientePermitido | null = null;
  let melhorScore = 0;
  let segundoScore = 0;
  const frase = ` ${q} `;
  for (const c of clientes) {
    const nome = normalizarEntidade(c.display_name);
    if (!nome) continue;
    let score = 0;
    if (frase.includes(` ${nome} `)) score = 1000 + nome.length;
    else {
      const tokens = nome.split(" ").filter((t) => t.length >= 3);
      const exatos = tokens.filter((t) => qTokens.has(t));
      const unicos = exatos.filter((t) => t.length >= 4 && frequencia.get(t) === 1);
      let fuzzy = 0;
      for (const nt of tokens.filter((t) => t.length >= 6 && !qTokens.has(t))) {
        if ([...qTokens].some((qt) => qt.length >= 6 && Math.abs(qt.length - nt.length) <= 2 && distanciaEdicao(qt, nt) <= 2)) fuzzy++;
      }
      if (exatos.length >= 2) score = 650 + exatos.length * 20;
      else if (exatos.length >= 1 && fuzzy >= 1) score = 560 + fuzzy * 20;
      else if (unicos.length >= 1) score = 480 + unicos[0].length;
    }
    if (score > melhorScore) {
      segundoScore = melhorScore;
      melhorScore = score;
      melhor = c;
    } else if (score > segundoScore) segundoScore = score;
  }
  if (!melhor || melhorScore < 480 || (segundoScore > 0 && melhorScore - segundoScore < 20)) return null;
  return melhor;
}

