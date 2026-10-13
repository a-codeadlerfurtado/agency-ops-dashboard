/**
 * Corte da fala da Jarvis em blocos de sintese.
 *
 * A resposta chega inteira do servidor (o agente sanitiza o texto completo antes
 * de emitir), entao o ganho nao vem de falar token a token: vem de nao esperar a
 * sintese do texto TODO antes do primeiro som. A primeira frase vira um pedido
 * curto de TTS, que volta rapido; o restante e' sintetizado em paralelo e entra
 * na sequencia.
 *
 * Sao no maximo DOIS blocos, de proposito. Com voz clonada cada emenda pode ser
 * audivel e cada bloco e' uma chamada de sintese: um unico corte, sempre em fim
 * de frase (onde ja existe pausa natural), compra a latencia sem picotar a voz.
 * Resposta curta continua sendo um bloco so.
 */

/** Abaixo disto a sintese inteira ja e' rapida; dividir so criaria uma emenda. */
export const FALA_MINIMA_PARA_DIVIDIR = 160;
/** A primeira parte precisa ser uma frase de verdade, nao um "Certo." solto. */
export const PRIMEIRO_BLOCO_MINIMO = 40;
/** Sobra menor que isto nao compensa um segundo pedido de sintese. */
export const SEGUNDO_BLOCO_MINIMO = 60;

// Ponto que NAO encerra frase: "Sr. Joao", "Av. Brasil", "n. 12".
const ABREVIACOES = new Set(["sr", "sra", "srs", "dr", "dra", "av", "r", "n", "tel", "ex", "obs", "ltda", "cia", "prof"]);

function terminaEmAbreviacao(trecho: string): boolean {
  const m = /([A-Za-zÀ-ÿ]+)\.$/.exec(trecho);
  return Boolean(m && ABREVIACOES.has(m[1].toLowerCase()));
}

/**
 * Devolve 1 ou 2 blocos. Juntos, sempre reproduzem o texto original (a menos de
 * espacos nas pontas), para a legenda e a fala nunca divergirem.
 */
export function dividirFala(texto: string): string[] {
  const limpo = String(texto ?? "").trim();
  if (limpo.length < FALA_MINIMA_PARA_DIVIDIR) return limpo ? [limpo] : [];

  // Fim de frase = pontuacao final seguida de espaco. "1.500" e "R$ 2,50" nao
  // tem espaco depois do ponto, entao nunca sao cortados.
  const fim = /[.!?\n]\s+/g;
  let m: RegExpExecArray | null;
  while ((m = fim.exec(limpo)) !== null) {
    const corte = m.index + 1;
    const primeiro = limpo.slice(0, corte).trim();
    const resto = limpo.slice(corte).trim();
    if (primeiro.length < PRIMEIRO_BLOCO_MINIMO) continue;
    if (terminaEmAbreviacao(primeiro)) continue;
    if (resto.length < SEGUNDO_BLOCO_MINIMO) break;
    return [primeiro, resto];
  }
  return [limpo];
}

/**
 * Envelope do medidor de nivel: sobe rapido, desce devagar. Sem isso o orbe
 * treme a cada silaba em vez de "respirar" com a voz.
 */
export function suavizarNivel(anterior: number, alvo: number, subida = 0.55, descida = 0.12): number {
  const a = Number.isFinite(anterior) ? anterior : 0;
  const b = Math.min(1, Math.max(0, Number.isFinite(alvo) ? alvo : 0));
  return a + (b - a) * (b > a ? subida : descida);
}

/** Limiares da interrupcao por voz. Ficam aqui para serem testados e ajustados num lugar so. */
export const INTERRUPCAO = {
  /** Janela inicial em que so se mede o que o microfone ouve da propria Jarvis. */
  calibragemMs: 350,
  /** Piso absoluto de RMS: abaixo disto nunca e' fala de quem esta' perto do microfone. */
  pisoRms: 0.05,
  /** Quantas vezes acima do eco medido a voz precisa estar. */
  fatorSobreEco: 2.5,
  /** Tempo continuo acima do limiar para valer como fala, e nao tosse ou clique. */
  sustentadoMs: 240,
  /** Intervalo de amostragem do detector. */
  passoMs: 40,
} as const;

export type EstadoInterrupcao = { ecoMax: number; acimaMs: number };

/**
 * Um passo do detector. Puro: recebe o tempo desde o inicio da fala e o RMS do
 * microfone, devolve o novo estado e se deve interromper.
 */
export function passoInterrupcao(
  estado: EstadoInterrupcao, decorridoMs: number, rms: number, cfg: typeof INTERRUPCAO = INTERRUPCAO,
): { estado: EstadoInterrupcao; interromper: boolean } {
  if (decorridoMs < cfg.calibragemMs) {
    return { estado: { ecoMax: Math.max(estado.ecoMax, rms), acimaMs: 0 }, interromper: false };
  }
  const limiar = Math.max(cfg.pisoRms, estado.ecoMax * cfg.fatorSobreEco);
  const acimaMs = rms > limiar ? estado.acimaMs + cfg.passoMs : Math.max(0, estado.acimaMs - cfg.passoMs);
  return { estado: { ecoMax: estado.ecoMax, acimaMs }, interromper: acimaMs >= cfg.sustentadoMs };
}
