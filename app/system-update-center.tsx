"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type UpdateItem = {
  sha: string;
  committed_at: string;
  title: string;
  subject?: string;
  added?: string[];
  fixed?: string[];
  removed?: string[];
  explanation?: string | null;
  target_roles?: string[];
};

type Payload = {
  ok: boolean;
  allowed?: boolean;
  mode?: "NONE" | "DAILY" | "PREVIEW_STACK";
  preview?: boolean;
  person?: string;
  role?: string;
  edition_date?: string;
  updates?: UpdateItem[];
};

const API = `${SUPABASE_URL}/functions/v1/agency-ops-system-updates-api`;

const roleLabel: Record<string, string> = {
  ALL: "Todos os perfis",
  MGMT: "Gestão",
  GT: "GT",
  CS: "CS",
  DESIGN: "Design",
  AI: "IA",
  COMMERCIAL: "Comercial",
};

function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00-03:00`);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long", year: "numeric" }).format(date);
}

function section(title: string, icon: string, items?: string[]) {
  if (!items?.length) return null;
  return (
    <div className="system-update-section">
      <div className="system-update-section-title"><span>{icon}</span>{title}</div>
      <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
    </div>
  );
}

function UpdateCard({ item, compact = false }: { item: UpdateItem; compact?: boolean }) {
  const scopes = item.target_roles?.length ? item.target_roles : ["ALL"];
  return (
    <article className={`system-update-card ${compact ? "is-compact" : ""}`}>
      <div className="system-update-card-head">
        <div>
          <div className="system-update-version">ATUALIZAÇÃO · {item.sha.slice(0, 7)}</div>
          <h3>{item.title || item.subject || "Atualização do sistema"}</h3>
        </div>
        <div className="system-update-scopes">
          {scopes.map((scope) => <span key={scope}>{roleLabel[scope] || scope}</span>)}
        </div>
      </div>
      <div className="system-update-card-grid">
        {section("Acrescentado", "+", item.added)}
        {section("Corrigido / melhorado", "✓", item.fixed)}
        {section("Retirado", "−", item.removed)}
      </div>
      {item.explanation ? (
        <div className="system-update-connected">
          <b>Como isso se liga ao seu trabalho</b>
          <p>{item.explanation}</p>
        </div>
      ) : null}
    </article>
  );
}

export default function SystemUpdateCenter() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [closing, setClosing] = useState(false);
  const [checking, setChecking] = useState(false);

  const api = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const response = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ action, ...extra }),
    });
    return response.json().catch(() => null);
  }, []);

  const check = useCallback(async () => {
    if (checking || payload) return;
    setChecking(true);
    try {
      const next = await api("CHECK") as Payload | null;
      if (!next?.ok || !next.allowed || !next.mode || next.mode === "NONE" || !next.updates?.length) return;
      setPayload(next);
      if (next.mode === "DAILY" && next.edition_date) {
        void api("MARK_SHOWN", {
          edition_date: next.edition_date,
          commit_shas: next.updates.map((item) => item.sha),
        });
      }
    } finally {
      setChecking(false);
    }
  }, [api, checking, payload]);

  useEffect(() => {
    const first = window.setTimeout(() => void check(), 900);
    const interval = window.setInterval(() => void check(), 60_000);
    const onVisible = () => { if (!document.hidden) void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  const updates = payload?.updates || [];
  const editionTitle = useMemo(() => payload?.edition_date ? formatDate(payload.edition_date) : "Hoje", [payload?.edition_date]);

  async function close() {
    if (!payload || closing) return;
    setClosing(true);
    try {
      if (payload.mode === "PREVIEW_STACK") await api("ACK_PREVIEW");
      else if (payload.mode === "DAILY" && payload.edition_date) {
        await api("DISMISS_DAILY", {
          edition_date: payload.edition_date,
          commit_shas: updates.map((item) => item.sha),
        });
      }
    } finally {
      setPayload(null);
      setClosing(false);
    }
  }

  if (!payload || !updates.length) return null;

  if (payload.mode === "PREVIEW_STACK") {
    return (
      <div className="system-update-overlay system-update-preview" role="dialog" aria-modal="true" aria-label="Prévia das atualizações do sistema">
        <div className="system-update-preview-shell">
          <header className="system-update-preview-head">
            <div>
              <span className="system-update-kicker">PRÉVIA · PERFIL ADLER</span>
              <h2>É assim que as atualizações vão aparecer</h2>
              <p>Últimos commits do Dashboard empilhados para você validar a experiência.</p>
            </div>
            <button type="button" onClick={close} disabled={closing}>Fechar prévia</button>
          </header>
          <div className="system-update-preview-stack">
            {updates.map((item, index) => (
              <div className="system-update-preview-layer" style={{ zIndex: updates.length - index }} key={item.sha}>
                <UpdateCard item={item} compact />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="system-update-overlay" role="dialog" aria-modal="true" aria-label="Atualização do sistema">
      <div className="system-update-modal">
        <header className="system-update-hero">
          <div className="system-update-kicker">PATCH NOTES · {editionTitle}</div>
          <h2>O Dashboard foi atualizado</h2>
          <p>{updates.length === 1 ? "1 mudança relevante para o seu perfil." : `${updates.length} mudanças relevantes para o seu perfil.`}</p>
        </header>
        <div className="system-update-list">
          {updates.map((item) => <UpdateCard item={item} key={item.sha} />)}
        </div>
        <footer className="system-update-footer">
          <span>Este resumo aparece uma única vez por dia útil, a partir das 08:30.</span>
          <button type="button" onClick={close} disabled={closing}>{closing ? "Fechando…" : "Entendi, continuar"}</button>
        </footer>
      </div>
    </div>
  );
}
