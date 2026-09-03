import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import { classeEtapa, iniciais } from "./lib/format";
import type { StageKind } from "./lib/types";

/* ============================================================== icones ===
   Set proprio, stroke 1.6, 16px. Evita 300kB de biblioteca de icones para
   usar 20 deles. */

type IcoProps = { size?: number; className?: string };
const svg = (d: ReactNode, size = 16, className?: string) => (
  <svg
    className={className ? `ico ${className}` : "ico"}
    width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >{d}</svg>
);

export const Ico = {
  home: (p: IcoProps = {}) => svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>, p.size, p.className),
  users: (p: IcoProps = {}) => svg(<><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 11a3 3 0 1 0-1.5-5.6" /><path d="M18 20a5.6 5.6 0 0 0-2-4.3" /></>, p.size, p.className),
  board: (p: IcoProps = {}) => svg(<><rect x="3" y="4" width="5" height="16" rx="1.4" /><rect x="10" y="4" width="5" height="11" rx="1.4" /><rect x="17" y="4" width="4" height="7" rx="1.4" /></>, p.size, p.className),
  check: (p: IcoProps = {}) => svg(<path d="m4.5 12.5 5 5 10-11" />, p.size, p.className),
  clock: (p: IcoProps = {}) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>, p.size, p.className),
  building: (p: IcoProps = {}) => svg(<><path d="M4 21V6l7-3v18" /><path d="M11 21h9V10l-9-3" /><path d="M7 9v.01M7 13v.01M7 17v.01M15 12v.01M15 16v.01" /></>, p.size, p.className),
  trophy: (p: IcoProps = {}) => svg(<><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3" /><path d="M10 14h4l.6 5H9.4z" /><path d="M8 21h8" /></>, p.size, p.className),
  gear: (p: IcoProps = {}) => svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" /></>, p.size, p.className),
  plus: (p: IcoProps = {}) => svg(<path d="M12 5v14M5 12h14" />, p.size, p.className),
  search: (p: IcoProps = {}) => svg(<><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.8-4.8" /></>, p.size, p.className),
  whats: (p: IcoProps = {}) => svg(<><path d="M3.5 20.5 5 16.4A8.2 8.2 0 1 1 8.2 19.6z" /><path d="M9 9.4c.4 2.4 3.2 5.2 5.6 5.6l1.1-1.5 1.9.9v1.7c-2.9.7-7.6-3-8.5-6.2l1.6-1z" /></>, p.size, p.className),
  note: (p: IcoProps = {}) => svg(<><path d="M5 4h14v16H5z" /><path d="M8.5 9h7M8.5 13h7M8.5 17h4" /></>, p.size, p.className),
  bell: (p: IcoProps = {}) => svg(<><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9z" /><path d="M10 18.5a2 2 0 0 0 4 0" /></>, p.size, p.className),
  out: (p: IcoProps = {}) => svg(<><path d="M14 3h5v18h-5" /><path d="M11 8 7 12l4 4" /><path d="M7 12h9" /></>, p.size, p.className),
  menu: (p: IcoProps = {}) => svg(<path d="M4 7h16M4 12h16M4 17h16" />, p.size, p.className),
  back: (p: IcoProps = {}) => svg(<path d="M14 6l-6 6 6 6" />, p.size, p.className),
  fire: (p: IcoProps = {}) => svg(<path d="M12 3s4.5 4 4.5 8a4.5 4.5 0 0 1-9 0c0-1.4.7-2.6 1.4-3.4.2 1.4 1 2.1 1.8 2.1 1.3 0 1.3-2.4 1.3-6.7z" />, p.size, p.className),
  alert: (p: IcoProps = {}) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.01" /></>, p.size, p.className),
  arrow: (p: IcoProps = {}) => svg(<path d="M5 12h13M13 7l5 5-5 5" />, p.size, p.className),
  mail: (p: IcoProps = {}) => svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></>, p.size, p.className),
  phone: (p: IcoProps = {}) => svg(<path d="M6 3h3l1.5 4.5-2 1.5a12 12 0 0 0 6.5 6.5l1.5-2L21 15v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 5.2 2 2 0 0 1 6 3z" />, p.size, p.className),
};

export const MarcaImobiBoard = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 20V9.2L12 3l9 6.2V20" stroke="#1b0d04" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 20v-5.5h7V20" stroke="#1b0d04" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ============================================================== atomos === */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`.trim()}>{children}</div>;
}

export function Stat({
  rotulo, valor, rodape, tom,
}: { rotulo: string; valor: ReactNode; rodape?: ReactNode; tom?: "up" | "down" }) {
  return (
    <Card className="stat">
      <div className="stat-label">{rotulo}</div>
      <div className="stat-value">{valor}</div>
      {rodape != null && <div className={`stat-foot ${tom ?? ""}`.trim()}>{rodape}</div>}
    </Card>
  );
}

export function EtapaBadge({ kind, nome }: { kind: StageKind; nome: string }) {
  return (
    <span className={`badge ${classeEtapa(kind)}`}>
      <span className="dot" />
      {nome}
    </span>
  );
}

export function Avatar({ nome, tamanho = "" }: { nome: string | null | undefined; tamanho?: "lg" | "" }) {
  if (!nome) return <span className={`avatar unassigned ${tamanho}`.trim()} title="Sem corretor">--</span>;
  return <span className={`avatar ${tamanho}`.trim()} title={nome}>{iniciais(nome)}</span>;
}

export const Skeleton = ({ h = 16, w = "100%" }: { h?: number; w?: number | string }) => (
  <div className="skel" style={{ height: h, width: w }} />
);

export function TabelaCarregando({ linhas = 5, colunas = 5 }: { linhas?: number; colunas?: number }) {
  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: linhas }, (_, i) => (
        <div key={i} className="row" style={{ gap: 14 }}>
          {Array.from({ length: colunas }, (_, j) => (
            <Skeleton key={j} h={14} w={j === 0 ? "26%" : "16%"} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Vazio({
  icone, titulo, texto, acao,
}: { icone?: ReactNode; titulo: string; texto?: string; acao?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icone ?? Ico.search({ size: 20 })}</div>
      <h3>{titulo}</h3>
      {texto && <p>{texto}</p>}
      {acao}
    </div>
  );
}

export function Alerta({ tipo = "err", children }: { tipo?: "err" | "warn" | ""; children: ReactNode }) {
  return (
    <div className={`alert ${tipo}`.trim()}>
      <span style={{ flexShrink: 0, marginTop: 1 }}>{Ico.alert({ size: 15 })}</span>
      <div>{children}</div>
    </div>
  );
}

/* ============================================================== toasts === */

type Toast = { id: number; tipo: "ok" | "err" | "info"; texto: string };
const ToastCtx = createContext<(tipo: Toast["tipo"], texto: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ProvedorDeToasts({ children }: { children: ReactNode }) {
  const [lista, setLista] = useState<Toast[]>([]);
  const seq = useRef(0);

  const avisar = useCallback((tipo: Toast["tipo"], texto: string) => {
    const id = ++seq.current;
    setLista((l) => [...l, { id, tipo, texto }]);
    setTimeout(() => setLista((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={avisar}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {lista.map((t) => (
          <div key={t.id} className={`toast ${t.tipo}`}>
            <span style={{ flexShrink: 0, marginTop: 1 }}>
              {t.tipo === "ok" ? Ico.check({ size: 15 }) : Ico.alert({ size: 15 })}
            </span>
            <span>{t.texto}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* =============================================================== hooks === */

/** Carrega dado assincrono guardando contra resposta fora de ordem. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [estado, setEstado] = useState<{
    carregando: boolean; dado?: T; erro?: string;
  }>({ carregando: true });
  const [gatilho, setGatilho] = useState(0);

  useEffect(() => {
    let atual = true;
    setEstado((e) => ({ ...e, carregando: true, erro: undefined }));
    fn()
      .then((d) => atual && setEstado({ carregando: false, dado: d }))
      .catch((e: unknown) =>
        atual && setEstado({ carregando: false, erro: (e as Error).message ?? String(e) })
      );
    return () => { atual = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, gatilho]);

  return { ...estado, recarregar: () => setGatilho((g) => g + 1) };
}
