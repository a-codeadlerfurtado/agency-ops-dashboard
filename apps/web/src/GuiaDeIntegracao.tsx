import { useEffect, useState } from "react";
import Dialogo from "./Dialogo";
import { Alerta } from "./ui";

/**
 * Guia passo a passo de uma integração.
 *
 * A configuração acontece fora do CRM — dentro do Google Ads, do Gerenciador
 * da Meta, do painel do site. Texto sozinho não resolve: quem está do outro
 * lado precisa reconhecer a tela. Por isso cada passo tem uma imagem, e o
 * texto fica curto embaixo dela.
 *
 * As imagens vivem em `public/guias/<canal>/passo-N.png` e são referenciadas
 * por caminho, não importadas. É deliberado: trocar o print vira soltar um
 * arquivo na pasta, sem tocar em código nem rebuildar nada além do deploy.
 *
 * Enquanto o print não existe, o lugar dele mostra o nome do arquivo esperado
 * em vez de um ícone quebrado — assim quem for tirar o print sabe exatamente
 * onde ele vai entrar.
 */

export interface PassoDoGuia {
  titulo: string;
  texto: string;
  /** caminho a partir de /guias; ex.: "google/passo-2.png" */
  imagem?: string;
  /** o último passo pode mostrar os campos da conexão já criada */
  mostrarCredenciais?: boolean;
}

function ImagemDoPasso({ src }: { src?: string }) {
  const [falhou, setFalhou] = useState(false);
  useEffect(() => { setFalhou(false); }, [src]);

  const caixa: React.CSSProperties = {
    width: "100%", aspectRatio: "16 / 9", borderRadius: 12,
    border: "1px solid var(--line)", background: "var(--panel-2)",
    display: "grid", placeItems: "center", overflow: "hidden",
    marginBottom: 14,
  };

  if (!src || falhou) {
    return (
      <div style={caixa}>
        <div style={{ textAlign: "center", padding: 16 }}>
          <div style={{ fontSize: 12, color: "var(--text-subtle)", marginBottom: 6 }}>
            print ainda nao adicionado
          </div>
          {src && (
            <code style={{ fontSize: 11.5, color: "var(--muted)" }}>
              public/guias/{src}
            </code>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={caixa}>
      <img
        src={`/guias/${src}`}
        alt=""
        onError={() => setFalhou(true)}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />
    </div>
  );
}

function CampoCopiavel({ rotulo, valor }: { rotulo: string; valor: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{rotulo}</div>
      <div className="row" style={{ gap: 8, alignItems: "stretch" }}>
        <code style={{
          flex: 1, minWidth: 0, padding: "9px 11px", borderRadius: 9,
          border: "1px solid var(--line)", background: "var(--panel-2)",
          overflowWrap: "anywhere", fontSize: 12.5,
        }}>{valor}</code>
        <button
          type="button" className="btn sm"
          onClick={() => {
            void navigator.clipboard.writeText(valor);
            setCopiado(true);
            setTimeout(() => setCopiado(false), 1600);
          }}
        >
          {copiado ? "Copiado" : "Copiar"}
        </button>
      </div>
    </div>
  );
}

export default function GuiaDeIntegracao({
  aberto,
  titulo,
  passos,
  credenciais,
  aoFechar,
}: {
  aberto: boolean;
  titulo: string;
  passos: PassoDoGuia[];
  /** só existe depois que a conexão foi criada e o token ainda está em mãos */
  credenciais?: { url: string; chave?: string } | null;
  aoFechar: () => void;
}) {
  const [i, setI] = useState(0);

  // reabrir sempre começa do primeiro passo: quem abre de novo costuma ter
  // perdido o fio, não parado no meio
  useEffect(() => { if (aberto) setI(0); }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, passos.length - 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [aberto, passos.length]);

  const passo = passos[Math.min(i, passos.length - 1)];
  if (!passo) return null;
  const ultimo = i === passos.length - 1;

  return (
    <Dialogo
      aberto={aberto}
      titulo={titulo}
      aoFechar={aoFechar}
      largura={620}
      rodape={
        <>
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
            {i + 1} de {passos.length}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => setI((n) => Math.max(n - 1, 0))} disabled={i === 0}>
            Anterior
          </button>
          {ultimo ? (
            <button className="btn primary" onClick={aoFechar}>Concluir</button>
          ) : (
            <button className="btn primary" onClick={() => setI((n) => n + 1)}>
              Proximo
            </button>
          )}
        </>
      }
    >
      <ImagemDoPasso src={passo.imagem} />

      <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{passo.titulo}</h3>
      <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5, lineHeight: 1.6 }}>
        {passo.texto}
      </p>

      {passo.mostrarCredenciais && (
        <div style={{ marginTop: 16 }}>
          {credenciais ? (
            <>
              <CampoCopiavel rotulo="URL de callback" valor={credenciais.url} />
              {credenciais.chave && (
                <CampoCopiavel rotulo="Chave" valor={credenciais.chave} />
              )}
            </>
          ) : (
            <Alerta tipo="warn">
              A URL e a chave aparecem uma unica vez, no momento em que a conexao
              e criada. Se voce ja fechou aquela tela, gere um token novo no card
              da conexao -- o antigo para de funcionar na hora.
            </Alerta>
          )}
        </div>
      )}

      {/* trilha de progresso: dá noção de tamanho antes de começar */}
      <div className="row" style={{ gap: 5, marginTop: 18 }}>
        {passos.map((_, n) => (
          <button
            key={n}
            type="button"
            aria-label={`Ir para o passo ${n + 1}`}
            onClick={() => setI(n)}
            style={{
              flex: 1, height: 3, borderRadius: 99, border: 0, padding: 0,
              cursor: "pointer",
              background: n <= i ? "var(--accent)" : "var(--line)",
            }}
          />
        ))}
      </div>
    </Dialogo>
  );
}
