"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, authenticatedFetch, SUPABASE_URL } from "./shared";
import type { Row } from "./shared";

const LEARNING_API = `${SUPABASE_URL}/functions/v1/agency-ops-creative-learning-api`;
const PROFILE_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "audience", label: "Público", placeholder: "Quem queremos atingir, padrão de vida, intenção de compra..." },
  { key: "product_focus", label: "Foco de produto", placeholder: "Quais produtos, imóveis ou ofertas devem ter prioridade..." },
  { key: "objectives", label: "Objetivos", placeholder: "O que a comunicação precisa gerar ou reforçar..." },
  { key: "region", label: "Região", placeholder: "Praças, bairros, cidades e particularidades locais..." },
  { key: "client_type", label: "Tipo de cliente", placeholder: "Perfil comercial e posicionamento do cliente..." },
  { key: "bottlenecks", label: "Gargalos", placeholder: "Pontos que costumam gerar retrabalho ou travar aprovação..." },
  { key: "risks", label: "Riscos", placeholder: "O que pode causar reclamação, erro factual ou desalinhamento..." },
  { key: "commercial_conditions", label: "Condições comerciais", placeholder: "Condições recorrentes que impactam a comunicação..." },
];

const RULE_KINDS = [
  ["DESEJA", "Preferência"],
  ["EVITAR", "Não fazer"],
  ["COMO_APLICAR", "Como aplicar"],
  ["IDENTIDADE", "Identidade"],
  ["PROCESSO", "Processo"],
  ["DADO_TECNICO", "Fato autorizado"],
] as const;

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  border: "1px solid #33434f",
  background: "#0d1419",
  color: "#f3f6f8",
  borderRadius: 10,
  padding: "10px 11px",
  font: "inherit",
  outline: "none",
};

const buttonStyle = {
  border: "1px solid #3a4954",
  background: "rgba(255,255,255,.04)",
  color: "#f3f6f8",
  borderRadius: 10,
  padding: "9px 12px",
  cursor: "pointer",
  font: "inherit",
};

const accentButtonStyle = {
  ...buttonStyle,
  border: "1px solid rgba(255,122,47,.65)",
  background: "rgba(255,122,47,.14)",
  fontWeight: 800,
};

function normalize(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

function findByExactText(selector: string, value: string): HTMLElement | null {
  return Array.from(document.querySelectorAll(selector)).find((element) => normalize(element.textContent) === normalize(value)) as HTMLElement || null;
}

function editorTarget(): HTMLElement | null {
  const eyebrow = findByExactText(".eyebrow", "Manual do cliente");
  return (eyebrow?.parentElement?.parentElement as HTMLElement | null) || null;
}

function audienceTarget(): HTMLElement | null {
  const title = findByExactText("b", "Público & abordagem do briefing");
  return title?.parentElement as HTMLElement | null;
}

function selectedClientName(): string {
  const eyebrow = findByExactText(".eyebrow", "Manual do cliente");
  return String(eyebrow?.parentElement?.querySelector("h2")?.textContent || "").trim();
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseAssets(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [left, right] = line.split("|").map((item) => item.trim());
    const url = right || left;
    if (!/^https?:\/\//i.test(url)) return [];
    return [{ label: right ? left || "Arquivo" : "Arquivo", url }];
  });
}

function formatAssets(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.map((item: Row) => `${item.label || "Arquivo"} | ${item.url || ""}`.trim()).filter(Boolean).join("\n");
}

function formatDateTime(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export default function CreativeManualEditBridge() {
  const [visible, setVisible] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [audienceMount, setAudienceMount] = useState<HTMLElement | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [base, setBase] = useState<Row | null>(null);
  const [learning, setLearning] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"profile" | "brand" | "rules">("profile");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [profileDraft, setProfileDraft] = useState<Row>({});
  const [colors, setColors] = useState("");
  const [fonts, setFonts] = useState("");
  const [logoRules, setLogoRules] = useState("");
  const [visualDirection, setVisualDirection] = useState("");
  const [assets, setAssets] = useState("");
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [ruleKind, setRuleKind] = useState("DESEJA");
  const [ruleText, setRuleText] = useState("");
  const [ruleScope, setRuleScope] = useState("");

  useEffect(() => {
    const inspect = () => {
      const hasCreative = Boolean(findByExactText("h2", "Central Criativa"));
      setVisible(hasCreative);
      setTarget(hasCreative ? editorTarget() : null);
      setAudienceMount(hasCreative ? audienceTarget() : null);
      setSelectedName(hasCreative ? selectedClientName() : "");
    };
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  async function load() {
    if (!visible) return;
    try {
      const [creative, learnedResponse] = await Promise.all([
        api("creative", ""),
        authenticatedFetch(LEARNING_API, { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error(`Perfil criativo ${response.status}`);
          return response.json();
        }),
      ]);
      setBase(creative);
      setLearning(learnedResponse);
    } catch {
      setBase(null);
      setLearning(null);
    }
  }

  useEffect(() => { void load(); }, [visible]);

  const selected = useMemo(() => {
    const clients = (base?.clients || []) as Row[];
    return clients.find((client) => normalize(client.display_name) === normalize(selectedName)) || null;
  }, [base, selectedName]);

  const manualProfile = useMemo(() => {
    const rows = (learning?.manual_profiles || []) as Row[];
    return rows.find((row) => String(row.client_id) === String(selected?.client_id)) || null;
  }, [learning, selected?.client_id]);

  const canEdit = Boolean(learning?.editor?.can_edit);
  const confirmedRules = useMemo(() => ((selected?.rules || []) as Row[]).filter((rule) => String(rule.status || "").toUpperCase() === "CONFIRMED"), [selected]);
  const clientEdits = useMemo(() => ((learning?.manual_edits || []) as Row[]).filter((item) => String(item.entity_id) === String(selected?.client_id)).slice(0, 8), [learning, selected?.client_id]);

  function resetDrafts() {
    const manual = manualProfile || {};
    const nextProfile: Row = {};
    for (const field of PROFILE_FIELDS) nextProfile[field.key] = String(manual[field.key] || "");
    setProfileDraft(nextProfile);
    setColors(Array.isArray(selected?.brand?.color_palette) ? selected.brand.color_palette.join(", ") : "");
    setFonts(Array.isArray(selected?.brand?.fonts) ? selected.brand.fonts.join(", ") : "");
    setLogoRules(String(selected?.brand?.logo_rules || ""));
    setVisualDirection(String(selected?.brand?.visual_direction || ""));
    setAssets(formatAssets(selected?.brand?.asset_links));
    setRuleId(null);
    setRuleKind("DESEJA");
    setRuleText("");
    setRuleScope("");
    setMessage("");
  }

  function openEditor(nextSection: "profile" | "brand" | "rules" = "profile") {
    if (!selected || !canEdit) return;
    resetDrafts();
    setSection(nextSection);
    setOpen(true);
  }

  async function post(payload: Row, reloadPage = false) {
    if (!selected) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await authenticatedFetch(LEARNING_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, client_id: selected.client_id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `Erro ${response.status}`);
      setMessage("Salvo com histórico de alteração.");
      await load();
      if (reloadPage) window.setTimeout(() => window.location.reload(), 450);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  function editRule(rule: Row) {
    setRuleId(String(rule.id));
    setRuleKind(String(rule.rule_kind || "DESEJA"));
    setRuleText(String(rule.rule_text || ""));
    setRuleScope(String(rule.product_scope || ""));
    setSection("rules");
  }

  async function archiveRule(rule: Row) {
    if (!window.confirm(`Arquivar esta regra?\n\n${rule.rule_text || ""}`)) return;
    await post({ action: "archive_rule", rule_id: rule.id }, true);
  }

  if (!visible) return null;

  const button = canEdit && selected && target ? createPortal(
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginLeft: "auto" }}>
      {manualProfile?.updated_by && <span style={{ fontSize: 11, color: "#9eacb7" }}>Manual: {manualProfile.updated_by}</span>}
      <button onClick={() => openEditor("profile")} style={accentButtonStyle}>✎ Editar perfil</button>
    </div>,
    target,
  ) : null;

  const manualAudience = selected && manualProfile && audienceMount ? createPortal(
    <div style={{ marginTop: 14, borderTop: "1px solid #2b3944", paddingTop: 13 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <b style={{ fontSize: 13 }}>Controle manual da equipe</b>
          <div style={{ color: "#9eacb7", fontSize: 11, marginTop: 3 }}>
            Confirmado por {manualProfile.updated_by || "equipe"}{manualProfile.updated_at ? ` · ${formatDateTime(manualProfile.updated_at)}` : ""}
          </div>
        </div>
        {canEdit && <button onClick={() => openEditor("profile")} style={{ ...buttonStyle, padding: "7px 10px", fontSize: 12 }}>Editar</button>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 10 }}>
        {PROFILE_FIELDS.filter((field) => manualProfile[field.key]).map((field) => <div key={field.key} style={{ border: "1px solid #2b3944", background: "rgba(255,255,255,.025)", borderRadius: 10, padding: 10 }}>
          <b style={{ fontSize: 11 }}>{field.label}</b>
          <div style={{ color: "#aeb9c1", fontSize: 12, lineHeight: 1.45, marginTop: 4, whiteSpace: "pre-wrap" }}>{manualProfile[field.key]}</div>
        </div>)}
      </div>
    </div>,
    audienceMount,
  ) : null;

  const modal = open && selected ? createPortal(
    <div role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(2,7,10,.78)", backdropFilter: "blur(8px)", display: "grid", placeItems: "center", padding: 18 }}>
      <div style={{ width: "min(900px, 96vw)", maxHeight: "90vh", overflow: "auto", background: "#10171c", color: "#f3f6f8", border: "1px solid #33434f", borderRadius: 18, boxShadow: "0 28px 80px rgba(0,0,0,.5)" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 2, background: "rgba(16,23,28,.96)", backdropFilter: "blur(8px)", borderBottom: "1px solid #2b3944", padding: "16px 18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
            <div><div style={{ color: "#ff8b4b", textTransform: "uppercase", letterSpacing: ".09em", fontSize: 11, fontWeight: 800 }}>Controle humano</div><h2 style={{ margin: "3px 0 4px", fontSize: 22 }}>{selected.display_name}</h2><div style={{ color: "#9eacb7", fontSize: 12 }}>O sistema continua aprendendo, mas estas edições humanas ficam identificadas e auditadas.</div></div>
            <button onClick={() => setOpen(false)} style={{ ...buttonStyle, padding: "7px 10px" }}>Fechar ×</button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 13 }}>
            {([['profile','Público & contexto'],['brand','Identidade'],['rules','Regras']] as const).map(([key, label]) => <button key={key} onClick={() => setSection(key)} style={{ ...(section === key ? accentButtonStyle : buttonStyle), padding: "7px 10px", fontSize: 12 }}>{label}</button>)}
          </div>
        </div>

        <div style={{ padding: 18 }}>
          {section === "profile" && <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
              {PROFILE_FIELDS.map((field) => <label key={field.key} style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{field.label}</span>
                <textarea value={String(profileDraft[field.key] || "")} onChange={(event) => setProfileDraft((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} rows={4} style={{ ...fieldStyle, resize: "vertical" }} />
              </label>)}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}><button disabled={saving} onClick={() => void post({ action: "save_manual_profile", profile: profileDraft }, false)} style={accentButtonStyle}>{saving ? "Salvando..." : "Salvar contexto manual"}</button></div>
          </div>}

          {section === "brand" && <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: 12, fontWeight: 700 }}>Cores</span><input value={colors} onChange={(event) => setColors(event.target.value)} placeholder="#2C2C59, #EE815A, #FFFFFF" style={fieldStyle} /></label>
            <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: 12, fontWeight: 700 }}>Fontes</span><input value={fonts} onChange={(event) => setFonts(event.target.value)} placeholder="Inter, Montserrat..." style={fieldStyle} /></label>
            <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: 12, fontWeight: 700 }}>Direção visual</span><textarea value={visualDirection} onChange={(event) => setVisualDirection(event.target.value)} rows={4} style={{ ...fieldStyle, resize: "vertical" }} /></label>
            <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: 12, fontWeight: 700 }}>Regras do logo</span><textarea value={logoRules} onChange={(event) => setLogoRules(event.target.value)} rows={3} style={{ ...fieldStyle, resize: "vertical" }} /></label>
            <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: 12, fontWeight: 700 }}>Arquivos da marca</span><textarea value={assets} onChange={(event) => setAssets(event.target.value)} placeholder={'Logo principal | https://...\nManual | https://...'} rows={4} style={{ ...fieldStyle, resize: "vertical" }} /><span style={{ color: "#8997a1", fontSize: 11 }}>Um por linha: Nome | URL.</span></label>
            <div style={{ display: "flex", justifyContent: "flex-end" }}><button disabled={saving} onClick={() => void post({ action: "save_brand", color_palette: splitList(colors), fonts: splitList(fonts), visual_direction: visualDirection, logo_rules: logoRules, asset_links: parseAssets(assets) }, true)} style={accentButtonStyle}>{saving ? "Salvando..." : "Salvar identidade"}</button></div>
          </div>}

          {section === "rules" && <div style={{ display: "grid", gap: 16 }}>
            <div style={{ border: "1px solid #2b3944", borderRadius: 14, padding: 14, background: "rgba(255,255,255,.02)" }}>
              <b>{ruleId ? "Editar regra confirmada" : "Adicionar regra confirmada"}</b>
              <div style={{ display: "grid", gridTemplateColumns: "180px minmax(180px, 1fr)", gap: 9, marginTop: 10 }}>
                <select value={ruleKind} onChange={(event) => setRuleKind(event.target.value)} style={fieldStyle}>{RULE_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                <input value={ruleScope} onChange={(event) => setRuleScope(event.target.value)} placeholder="Escopo do produto (vazio = regra geral)" style={fieldStyle} />
              </div>
              <textarea value={ruleText} onChange={(event) => setRuleText(event.target.value)} placeholder="Escreva a regra exatamente como o time deve seguir." rows={4} style={{ ...fieldStyle, resize: "vertical", marginTop: 9 }} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 9 }}>
                {ruleId && <button onClick={() => { setRuleId(null); setRuleKind("DESEJA"); setRuleText(""); setRuleScope(""); }} style={buttonStyle}>Cancelar edição</button>}
                <button disabled={saving || !ruleText.trim()} onClick={() => void post({ action: "save_rule", rule_id: ruleId, rule_kind: ruleKind, rule_text: ruleText, product_scope: ruleScope }, true)} style={accentButtonStyle}>{saving ? "Salvando..." : ruleId ? "Salvar alteração" : "Adicionar regra"}</button>
              </div>
            </div>

            <div>
              <b>Regras confirmadas · {confirmedRules.length}</b>
              <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!confirmedRules.length && <div style={{ color: "#9eacb7", fontSize: 13 }}>Nenhuma regra confirmada ainda.</div>}
                {confirmedRules.map((rule) => <div key={rule.id} style={{ border: "1px solid #2b3944", borderRadius: 12, padding: 12, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div><b style={{ fontSize: 12 }}>{RULE_KINDS.find(([value]) => value === rule.rule_kind)?.[1] || rule.rule_kind}</b><div style={{ color: "#b3bec6", fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>{rule.rule_text}</div>{rule.product_scope && <div style={{ color: "#80909a", fontSize: 10, marginTop: 5 }}>Escopo: {rule.product_scope}</div>}</div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => editRule(rule)} style={{ ...buttonStyle, padding: "6px 8px", fontSize: 11 }}>Editar</button><button onClick={() => void archiveRule(rule)} style={{ ...buttonStyle, padding: "6px 8px", fontSize: 11 }}>Arquivar</button></div>
                </div>)}
              </div>
            </div>
          </div>}

          {message && <div style={{ marginTop: 14, border: "1px solid rgba(87,169,232,.35)", background: "rgba(87,169,232,.08)", borderRadius: 10, padding: 10, fontSize: 12 }}>{message}</div>}
          {clientEdits.length > 0 && <div style={{ marginTop: 18, borderTop: "1px solid #2b3944", paddingTop: 12 }}><b style={{ fontSize: 12 }}>Últimas alterações manuais</b><div style={{ display: "grid", gap: 5, marginTop: 7 }}>{clientEdits.map((item) => <div key={item.id} style={{ color: "#8f9da6", fontSize: 11 }}>{formatDateTime(item.created_at)} · {item.actor} · {String(item.action || "").replaceAll("CREATIVE_", "").replaceAll("_", " ")}</div>)}</div></div>}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return <>{button}{manualAudience}{modal}</>;
}
