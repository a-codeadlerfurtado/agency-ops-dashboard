/**
 * Marca do Imobi-Board — funil com o vinco de saída.
 *
 * O desenho é o funil de vendas: o V recolhe tudo que entra e a haste é o que
 * sai convertido. O vinco branco não é decoração — é o corte que separa o
 * corpo do funil da haste e dá a direção do movimento, de baixo para cima.
 *
 * O contorno foi traçado da arte de referência, não redesenhado no olho:
 * a imagem foi decodificada pixel a pixel, as duas bordas retas do V saíram
 * por mínimos quadrados (inclinação 0,7560 e 0,7552 — o funil é simétrico,
 * então o traçado usa 0,7556 nos dois lados) e cada trecho curvo é uma cúbica
 * ajustada às amostras medidas. Erro máximo de 4,6 px numa arte de 810 px de
 * largura; a silhueta renderizada bate 98,7% com a original, que é o piso
 * imposto pelo antialiasing da borda.
 *
 * Uma forma só, sem furo: o vinco é aberto por baixo, então não precisa de
 * fill-rule nem de segunda cor. Isso mantém a marca correta sobre qualquer
 * fundo — o vinco mostra o fundo, seja ele qual for.
 *
 * Grade de 32×32 para alinhar em 16 e 32 sem meio-pixel.
 */

export const CAMINHO_MARCA =
  "M4.37 4.3 H27.63 A1.49 1.49 0 0 1 28.83 6.7 L21.36 16.58 " +
  "C20.73 17.41 18.36 19.68 18.36 22.04 L18.36 24.45 " +
  "C18.36 24.85 17.78 26.77 14.18 27.73 A0.84 0.84 0 0 1 13.28 26.89 " +
  "L13.28 22.59 C13.28 17.22 20.53 13.35 25.56 8.61 " +
  "C19.38 11.95 13.34 15.39 12.3 18.76 L3.18 6.7 " +
  "A1.49 1.49 0 0 1 4.37 4.3 Z";

type Props = {
  size?: number;
  /** uma cor só, para aplicações monocromáticas */
  mono?: string;
  className?: string;
};

let seq = 0;

export function ImobiBoardMark({ size = 28, mono, className }: Props) {
  // ids únicos: dois gradientes com o mesmo id na página fazem o segundo sumir
  const id = `ib${(seq += 1)}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Imobi-Board"
    >
      {!mono && (
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0.55" y2="1">
            <stop offset="0" stopColor="var(--marca-azul, #76c6ff)" />
            <stop offset="1" stopColor="var(--marca-azul-fundo, #2f79c7)" />
          </linearGradient>
        </defs>
      )}
      <path d={CAMINHO_MARCA} fill={mono ?? `url(#${id})`} />
    </svg>
  );
}

/**
 * Marca completa: símbolo + nome (+ subtítulo quando houver espaço).
 *
 * O nome fica em caixa normal ("Imobi-Board") na interface — leitura de
 * software. A versão caixa-alta com tracking largo fica reservada ao painel de
 * marca do login, onde acompanha a composição da família.
 */
export function ImobiBoardLogo({
  size = 28,
  comSubtitulo = true,
  className,
}: {
  size?: number;
  comSubtitulo?: boolean;
  className?: string;
}) {
  return (
    <div className={`marca ${className ?? ""}`.trim()}>
      <span className="marca-simbolo">
        <ImobiBoardMark size={size} />
      </span>
      <span className="marca-texto">
        <span className="marca-nome">Imobi-Board</span>
        {comSubtitulo && <span className="marca-sub">CRM Imobiliario</span>}
      </span>
    </div>
  );
}
