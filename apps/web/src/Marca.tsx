/**
 * Marca do Imobi-Board — monograma "ib".
 *
 * Refinamento da Opção 28: o `i` azul e o `b` laranja formam um só símbolo.
 * A escolha entre as três variantes (28A arredondada, 28B geométrica, 28C
 * compacta) foi decidida pela REDUÇÃO, não pela versão grande:
 *
 *   variante | raio do bojo | espessura | contraforma
 *   28A      | 4.6          | 5.0       | 2.1
 *   28C      | 4.9          | 5.4       | 2.2
 *   final    | 5.2          | 5.0       | 2.7   ← 28% maior
 *
 * A contraforma (o buraco do `b`) é o primeiro detalhe que fecha ao reduzir.
 * Com 2.7 de raio ela ainda abre a 16px, que é o tamanho do favicon.
 *
 * Grade de 32×32 para alinhar em 16 e 32 sem meio-pixel.
 *
 * O desenho não depende da cor: em uma cor só continua lendo "ib" — critério
 * que o próprio briefing coloca como prova de que o desenho está bom.
 */

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
  const azul = mono ?? `url(#a${id})`;
  const laranja = mono ?? `url(#l${id})`;

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
          <linearGradient id={`a${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--marca-azul, #76c6ff)" />
            <stop offset="1" stopColor="var(--marca-azul-fundo, #2f79c7)" />
          </linearGradient>
          <linearGradient id={`l${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--marca-laranja, #ff9a4f)" />
            <stop offset="1" stopColor="var(--marca-laranja-fundo, #e9621d)" />
          </linearGradient>
        </defs>
      )}
      {/* i — ponto e haste */}
      <circle cx="7.7" cy="7.4" r="3" fill={azul} />
      <rect x="5" y="13.3" width="5.4" height="13.2" rx="2.7" fill={azul} />
      {/* b — haste alta e bojo. O bojo é traçado, não preenchido: é a
          contraforma que faz o `b` ser `b` e não um ponto grande. */}
      <rect x="12.8" y="4.3" width="5.4" height="22.2" rx="2.7" fill={laranja} />
      <circle cx="21.5" cy="19.6" r="5.2" fill="none" stroke={laranja} strokeWidth="5" />
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
