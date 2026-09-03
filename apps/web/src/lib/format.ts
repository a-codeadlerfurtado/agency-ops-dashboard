import type { StageKind } from "./types";

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

export const dinheiro = (v: number | null | undefined): string =>
  v == null ? "--" : brl.format(v);

/** VGV fica ilegivel em reais cheios: 3.490.000 vira "R$ 3,49 mi". */
export function dinheiroCurto(v: number | null | undefined): string {
  if (v == null) return "--";
  if (v >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(2).replace(".", ",")} mi`;
  if (v >= 1_000) return `R$ ${Math.round(v / 1_000)} mil`;
  return brl.format(v);
}

export const numero = (v: number | null | undefined): string =>
  v == null ? "--" : new Intl.NumberFormat("pt-BR").format(v);

export function dataHora(iso: string | null | undefined): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

export function data(iso: string | null | undefined): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
  });
}

/** "ha 3 dias", "em 2 h" - o corretor le tempo relativo mais rapido. */
export function relativo(iso: string | null | undefined): string {
  if (!iso) return "--";
  const ms = new Date(iso).getTime() - Date.now();
  const min = Math.round(ms / 60_000);
  const abs = Math.abs(min);

  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  if (abs < 60) return rtf.format(min, "minute");
  if (abs < 60 * 24) return rtf.format(Math.round(min / 60), "hour");
  if (abs < 60 * 24 * 30) return rtf.format(Math.round(min / (60 * 24)), "day");
  return rtf.format(Math.round(min / (60 * 24 * 30)), "month");
}

export function diasDesde(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function iniciais(nome: string | null | undefined): string {
  if (!nome) return "?";
  const p = nome.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? (p[p.length - 1]?.[0] ?? "") : "")) || "?";
}

export function primeiroNome(nome: string | null | undefined): string {
  return nome?.trim().split(/\s+/)[0] ?? "";
}

export const classeEtapa = (kind: StageKind): string =>
  ({
    NEW: "new", CONTACTED: "contacted", QUALIFIED: "qualified",
    VISIT: "visit", PROPOSAL: "proposal", WON: "won", LOST: "lost",
  })[kind];

export const rotuloOrigem = (source: string): string =>
  ({
    META_ADS: "Meta Ads",
    GOOGLE: "Google",
    INDICACAO: "Indicacao",
    MANUAL: "Manual",
    SITE: "Site",
  })[source] ?? source;

/**
 * Mesma normalizacao do banco (imobi_board_priv.normalize_phone_br), usada só
 * para montar o link do WhatsApp. A verdade continua sendo a do Postgres.
 */
export function linkWhatsapp(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && "6789".includes(d[2] ?? "")) d = d.slice(0, 2) + "9" + d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  return `https://wa.me/55${d}`;
}
