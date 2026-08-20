"use client";

// Aba CONTRATOS — privada do Adler.
//
// O backend e que autoriza: agency-ops-contracts-api responde 404 para qualquer
// usuario que nao seja o Adler. Este arquivo entra por import dinamico no
// page.tsx, entao o codigo aqui nem chega ao navegador de quem nao pode ver.

import { useEffect, useMemo, useState } from "react";
import { CONTRACTS_API, SUPABASE_ANON_KEY, Chip, formatDate, formatDay, formatNumber, text } from "../shared";
import type { Row } from "../shared";

// Contrato vencido NAO e churn. Se o cliente segue com task nos ultimos 30
// dias, a leitura correta e "precisamos renovar", nao "o cliente saiu".
function situacao(row: Row): { rotulo: string; tom: string; nota?: string } {
  const estado = String(row.contract_state || "");
  const dias = row.days_remaining == null ? null : Number(row.days_remaining);
  const operando = Number(row.tasks_last_30d || 0) > 0;

  if (row.renewal_pending) return { rotulo: "RENOVAÇÃO EM ANDAMENTO", tom: "#fbbf24", nota: "documento novo em processo" };
  // Verificado no texto dos contratos: a clausula 7.1 exige "expressa vontade
  // das partes" e a 9.4 diz que o contrato NAO se renova automaticamente. Entao
  // vencido + entrega em curso nao e' renovacao tacita: e' entrega sem cobertura
  // contratual, que e' o caso mais grave da lista, nao o mais tranquilo.
  // Renovacao confirmada pelo Adler, sem instrumento novo assinado. O cliente
  // nao esta' irregular nem em risco: a pendencia e' documental, e cobrar como
  // se fosse risco comercial afoga o caso que realmente precisa de acao.
  if (row.operational_signal === "RENEWED_UNDOCUMENTED") {
    return { rotulo: "RENOVADO · FALTA DOCUMENTO", tom: "#f59e0b",
             nota: "renovação confirmada; instrumento novo ainda não assinado" };
  }
  if (row.operational_signal === "OPERATING_UNCOVERED") {
    return { rotulo: "SEM CONTRATO VIGENTE", tom: "#ef4444",
             nota: `${formatNumber(row.tasks_after_expiry)} tasks entregues após o fim da vigência · exige novo instrumento` };
  }
  if (estado === "EXPIRED") {
    return row.operational_signal === "RENEWAL_NEEDED"
      ? { rotulo: "RENOVAÇÃO NECESSÁRIA", tom: "#ef4444", nota: "teve entrega, mas o grupo esfriou" }
      : operando
        ? { rotulo: "RENOVAÇÃO NECESSÁRIA", tom: "#ef4444", nota: "cliente continua na operação" }
        : { rotulo: "CONTRATO VENCIDO", tom: "#ef4444" };
  }
  if (dias === 0) return { rotulo: "VENCE HOJE", tom: "#ef4444" };
  if (estado === "EXPIRING_7") return { rotulo: "VENCE EM 7 DIAS", tom: "#ef4444" };
  if (estado === "EXPIRING_15") return { rotulo: "VENCE EM 15 DIAS", tom: "#f97316" };
  if (estado === "EXPIRING_30") return { rotulo: "VENCE EM 30 DIAS", tom: "#f59e0b" };
  if (estado === "EXPIRING_60") return { rotulo: "VENCE EM 60 DIAS", tom: "#f59e0b" };
  if (estado === "ACTIVE") return { rotulo: "CONTRATO VIGENTE", tom: "#22c55e" };
  if (estado === "TERM_UNKNOWN") return { rotulo: "VIGÊNCIA A IDENTIFICAR", tom: "#a78bfa", nota: "prazo nao confirmado no documento" };
  if (estado === "NO_CONTRACT") return { rotulo: "SEM CONTRATO LOCALIZADO", tom: "#94a3b8" };
  return { rotulo: estado || "—", tom: "#94a3b8" };
}

function prazo(dias: unknown, estado: string) {
  if (dias === null || dias === undefined) return "—";
  const n = Number(dias);
  if (estado === "EXPIRED" || n < 0) return `venceu há ${Math.abs(n)}d`;
  if (n === 0) return "vence hoje";
  return `${n}d restantes`;
}

const ESTADOS: [string, string][] = [
  ["ALL", "Todos os estados"], ["ACTIVE", "Contrato vigente"], ["EXPIRING_7", "Vence em 7 dias"],
  ["EXPIRING_15", "Vence em 15 dias"], ["EXPIRING_30", "Vence em 30 dias"], ["EXPIRING_60", "Vence em 60 dias"],
  ["EXPIRED", "Vencido"], ["TERM_UNKNOWN", "Vigência a identificar"], ["NO_CONTRACT", "Sem contrato localizado"],
];

export function ContractsCenter({ token }: { token: string }) {
  const [payload, setPayload] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [estado, setEstado] = useState("ALL");
  const [lifecycle, setLifecycle] = useState("ACTIVE");

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch(CONTRACTS_API, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) throw new Error(response.status === 404 ? "Área privada indisponível para este usuário." : "Falha ao carregar contratos.");
      setPayload(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar contratos.");
      setPayload(null);
    } finally { setLoading(false); }
  }

  async function marcarTodasLidas() {
    await fetch(CONTRACTS_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_all_notifications_read" }),
    });
    await load();
  }

  useEffect(() => { load(); }, [token]);

  const resumo = payload?.summary || {};
  const contratos: Row[] = payload?.contracts || [];
  const alertas: Row[] = payload?.notifications || [];
  const naoLidos = alertas.filter((n) => !n.read_at).length;
  const documentos = Number(payload?.source?.documents_ingested || 0);

  const filtrados = useMemo(() => {
    const busca = query.trim().toLocaleLowerCase("pt-BR");
    return contratos.filter((row) => {
      const okCiclo = lifecycle === "ALL" || (lifecycle === "ACTIVE" ? ["ACTIVE", "ONBOARDING"].includes(row.lifecycle) : row.lifecycle === lifecycle);
      const okEstado = estado === "ALL" || row.contract_state === estado;
      const okBusca = !busca || [row.display_name, row.document_name, row.cs_owner, row.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(busca);
      return okCiclo && okEstado && okBusca;
    });
  }, [contratos, query, estado, lifecycle]);

  if (error) return <section className="workspace"><div className="error-box">{error}</div></section>;

  const kpisPrincipais: [string, unknown, string][] = [
    ["Clientes ativos", resumo.active_clients, "#60a5fa"],
    ["Contratos OK", resumo.contracts_ok, "#22c55e"],
    ["Vencendo", resumo.expiring, "#f59e0b"],
    ["Vencidos + cliente ativo", resumo.expired_active, "#ef4444"],
    ["Vigência desconhecida", resumo.term_unknown, "#a78bfa"],
    ["Sem contrato localizado", resumo.no_contract, "#94a3b8"],
  ];
  const kpisJanela: [string, unknown, string][] = [
    ["Vence hoje", resumo.expiring_today, "#ef4444"],
    ["Em 7 dias", resumo.expiring_7, "#ef4444"],
    ["Em 15 dias", resumo.expiring_15, "#f97316"],
    ["Em 30 dias", resumo.expiring_30, "#f59e0b"],
    ["Em 60 dias", resumo.expiring_60, "#f59e0b"],
    ["Renovação em andamento", resumo.renewal_in_progress, "#fbbf24"],
    ["Renovação necessária", resumo.renewal_needed, "#ef4444"],
    ["Churned c/ contrato vigente", resumo.churned_with_active_contract, "#a78bfa"],
  ];

  return <section className="workspace">
    <div className="workspace-head">
      <div>
        <span className="eyebrow">PRIVADO · ADLER ONLY</span>
        <h2>Contratos</h2>
        <p>Autentique, vigência, renovação e atividade operacional.</p>
      </div>
      <button className="btn" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar contratos"}</button>
    </div>

    <section className="grid kpis">
      {kpisPrincipais.map(([rotulo, valor, cor]) => <article key={rotulo} className="card" style={{ padding: 15, borderColor: `${cor}33` }}>
        <small style={{ color: "#94a3b8", fontSize: 11 }}>{rotulo}</small>
        <div style={{ fontSize: 27, lineHeight: 1, fontWeight: 800, marginTop: 8, color: cor }}>{formatNumber(valor)}</div>
      </article>)}
    </section>

    <section className="grid kpis" style={{ marginTop: 10 }}>
      {kpisJanela.map(([rotulo, valor, cor]) => <article key={rotulo} className="card" style={{ padding: 12, borderColor: `${cor}22` }}>
        <small style={{ color: "#94a3b8", fontSize: 10 }}>{rotulo}</small>
        <div style={{ fontSize: 20, lineHeight: 1, fontWeight: 700, marginTop: 6, color: cor }}>{formatNumber(valor)}</div>
      </article>)}
    </section>

    {documentos === 0 && <div className="media-note" style={{ marginTop: 14 }}>
      ⚠ A estrutura privada está pronta, mas ainda há <b>0 documentos da Autentique ingeridos</b>. Enquanto o backfill não rodar, todo cliente aparece como “Sem contrato localizado” — isso é ausência de dado, não leitura comercial.
    </div>}

    <section className="card section" style={{ marginTop: 14 }}>
      <div className="section-head">
        <div>
          <div className="section-title">Carteira contratual</div>
          <div className="subtitle">{filtrados.length} registros no filtro · {formatNumber(documentos)} documentos da {text(payload?.source?.provider || "Autentique")}</div>
        </div>
        <div className="toolbar">
          <input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, CS, GT ou documento" />
          <select className="control" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
            <option value="ACTIVE">Clientes atuais</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option>
          </select>
          <select className="control" value={estado} onChange={(e) => setEstado(e.target.value)}>
            {ESTADOS.map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th scope="col">Cliente</th><th scope="col">Status do cliente</th><th scope="col">CS</th><th scope="col">GT</th><th scope="col">Documento</th><th scope="col">Status Autentique</th>
            <th scope="col">Data início</th><th scope="col">Data fim</th><th scope="col">Dias restantes</th><th scope="col">Status contratual</th>
            <th scope="col">Tasks 30d</th><th scope="col">Última task</th><th scope="col">Renovação</th><th scope="col">Documento/PDF</th>
          </tr></thead>
          <tbody>{filtrados.map((row) => {
            const s = situacao(row);
            const pdf = row.signed_file_url || row.original_file_url;
            return <tr key={row.client_id}>
              <td><div className="name">{text(row.display_name)}</div>{row.inconsistency && <div className="small" style={{ color: "#fca5a5" }}>{text(row.inconsistency)}</div>}</td>
              <td><Chip value={row.lifecycle} /></td>
              <td className="small">{text(row.cs_owner)}</td>
              <td className="small">{text(row.gt_owner)}</td>
              <td><div>{text(row.document_name)}</div>{row.client_match_status && row.client_match_status !== "MATCHED" && <div className="small" style={{ color: "#fbbf24" }}>vínculo: {text(row.client_match_status)}</div>}</td>
              <td className="small">{text(row.document_status)}</td>
              <td className="small">{formatDay(row.contract_start_date)}</td>
              <td className="small">{formatDay(row.contract_end_date)}{row.term_source && <div className="small" style={{ opacity: .7 }}>{text(row.term_source)}</div>}</td>
              <td><b style={{ color: s.tom }}>{prazo(row.days_remaining, String(row.contract_state || ""))}</b></td>
              <td><div style={{ color: s.tom, fontWeight: 700, fontSize: 12 }}>{s.rotulo}</div>{s.nota && <div className="small" style={{ color: "#fca5a5" }}>{s.nota}</div>}</td>
              <td className="small">{formatNumber(row.tasks_last_30d)}</td>
              <td className="small">{row.last_task_at ? formatDate(row.last_task_at) : "sem atividade"}</td>
              <td className="small">{row.renewal_pending ? "em andamento" : (String(row.contract_state) === "EXPIRED" ? "necessária" : "—")}</td>
              <td>{pdf ? <a className="btn" href={String(pdf)} target="_blank" rel="noreferrer">Abrir</a> : <span className="small">—</span>}</td>
            </tr>;
          })}{!filtrados.length && <tr><td colSpan={14} className="empty">Nenhum contrato nesse filtro.</td></tr>}</tbody>
        </table>
      </div>
    </section>

    <section className="card section" style={{ marginTop: 14 }}>
      <div className="section-head">
        <div><div className="section-title">Alertas privados de contratos</div><div className="subtitle">Somente Adler · {naoLidos} não lido(s)</div></div>
        {naoLidos > 0 && <button className="btn" onClick={marcarTodasLidas}>Marcar como lidos</button>}
      </div>
      <div className="notification-list">
        {alertas.slice(0, 30).map((item) => <div className={`notification-action${item.read_at ? "" : " unread"}`} key={item.id}>
          <Chip value={item.level} /><span><b>{text(item.title)}</b><small>{text(item.description)} · {formatDate(item.occurred_at)}</small></span>
        </div>)}
        {!alertas.length && <div className="empty">Nenhum alerta contratual privado.</div>}
      </div>
    </section>
  </section>;
}

// Secao "Contrato" dentro do drawer do cliente.
//
// So' e' montada quando o backend autorizou. Para os demais colaboradores ela
// nao existe — sem rotulo "oculto", sem "sem permissao", sem espaco vazio: o
// componente nem chega ao navegador, porque vem do mesmo import dinamico da aba.
export function ClientContractSection({ clientId, token }: { clientId: string; token: string }) {
  const [dados, setDados] = useState<Row | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    setCarregando(true);
    fetch(`${CONTRACTS_API}?client_id=${encodeURIComponent(clientId)}`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (ativo) { setDados(j?.ok ? j : null); setCarregando(false); } })
      .catch(() => { if (ativo) { setDados(null); setCarregando(false); } });
    return () => { ativo = false; };
  }, [clientId, token]);

  if (carregando) return null;

  const c = dados?.contract as Row | null | undefined;
  const historico: Row[] = dados?.history || [];
  if (!c && !historico.length) return null;

  const s = c ? situacao(c) : null;
  const pdf = c?.signed_file_url || c?.original_file_url;

  return <section className="detail-card">
    <h3>Contrato</h3>
    {c ? <>
      <p><b>Situação:</b> <span style={{ color: s!.tom, fontWeight: 700 }}>{s!.rotulo}</span></p>
      {s!.nota && <p className="small" style={{ color: "#fca5a5" }}>{s!.nota}</p>}
      <p><b>Início:</b> {formatDay(c.contract_start_date)} · <b>Fim:</b> {formatDay(c.contract_end_date)}</p>
      <p><b>Dias restantes:</b> {prazo(c.days_remaining, String(c.contract_state || ""))}</p>
      <p><b>Renovação:</b> {c.renewal_pending ? "documento novo em processo" : (String(c.contract_state) === "EXPIRED" ? "necessária" : "—")}</p>
      <p><b>Documento:</b> {text(c.document_name)} {pdf ? <a href={String(pdf)} target="_blank" rel="noreferrer">abrir PDF</a> : null}</p>
      {c.term_source && <p className="small" style={{ opacity: .75 }}>Vigência apurada por: {text(c.term_source)}{c.term_confidence != null ? ` · confiança ${Math.round(Number(c.term_confidence) * 100)}%` : ""}</p>}
    </> : <p className="small">Sem contrato localizado para este cliente.</p>}

    {historico.length > 1 && <>
      <p style={{ marginTop: 10 }}><b>Histórico</b></p>
      {historico.map((h) => <p key={String(h.id)} className="small">
        {formatDay(h.contract_start_date)} → {formatDay(h.contract_end_date)} · {text(h.document_name)}
        {h.renewal_of_contract_id ? " · renovação" : ""}
      </p>)}
    </>}
  </section>;
}
