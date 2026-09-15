"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
type HistoryPayload = {
  client?: Row;
  records?: Row[];
  permissions?: Row;
};

const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-context-api`;
const STYLE_ID = "client-context-upload-bridge-style";
const SLOT_CLASS = "client-context-upload-slot";
const MAX_BYTES = 2 * 1024 * 1024;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatDate(value: unknown) {
  if (!value) return "Data não identificada";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(d);
}

function sourceLabel(source: unknown) {
  const value = String(source || "").toUpperCase();
  if (value === "DASHBOARD_UPLOAD") return "Upload do time";
  if (value === "DONNAH") return "Donnah";
  return value || "Transcrição";
}

function validateFile(file: File) {
  const ext = file.name.toLowerCase().split(".").pop() || "";
  if (!["txt", "md"].includes(ext)) throw new Error("Envie um arquivo .txt ou .md.");
  if (file.size > MAX_BYTES) throw new Error("O arquivo precisa ter no máximo 2 MB.");
}

async function authenticatedFetch(url: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Sua sessão expirou. Entre novamente no dashboard.");
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const map: Record<string, string> = {
      forbidden: "Você não tem acesso a este cliente.",
      unsupported_file_type: "Envie um arquivo .txt ou .md.",
      file_too_large: "O arquivo ultrapassa o limite de 2 MB.",
      transcript_too_short: "A transcrição está vazia ou curta demais.",
      client_not_found: "Cliente não encontrado.",
    };
    throw new Error(map[String(payload?.error)] || payload?.message || `Não foi possível concluir (${response.status}).`);
  }
  return payload;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${SLOT_CLASS}{grid-column:1/-1;border:1px solid rgba(34,197,94,.20);border-radius:14px;padding:15px 16px;background:rgba(34,197,94,.025);min-width:0}.client-context-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.client-context-head h3{margin:0;font-size:14px}.client-context-head p{margin:4px 0 0;color:var(--muted);font-size:11px;line-height:1.45}.client-context-add{border:1px solid rgba(34,197,94,.28)!important;background:rgba(34,197,94,.10)!important;color:#34d399!important;font-weight:800!important;white-space:nowrap}.client-context-panel{display:none;margin-top:13px;padding:13px;border:1px solid var(--line);border-radius:12px;background:rgba(15,23,42,.22)}.client-context-panel.open{display:block}.client-context-form-grid{display:grid;grid-template-columns:180px 1fr;gap:10px}.client-context-field{display:flex;flex-direction:column;gap:5px;font-size:10px;color:var(--muted)}.client-context-field select,.client-context-field input,.client-context-field textarea{width:100%;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text);padding:9px 10px;font:inherit}.client-context-field textarea{min-height:76px;resize:vertical}.client-context-drop{margin-top:10px;border:1px dashed rgba(148,163,184,.35);border-radius:11px;padding:18px 12px;text-align:center;cursor:pointer;transition:.15s}.client-context-drop:hover,.client-context-drop.drag{border-color:#34d399;background:rgba(34,197,94,.05)}.client-context-drop b{display:block;font-size:12px}.client-context-drop small{display:block;color:var(--muted);margin-top:4px}.client-context-file{margin-top:7px;color:#34d399;font-size:10px}.client-context-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:11px}.client-context-message{margin-right:auto;font-size:10px;color:var(--muted)}.client-context-message.error{color:#f87171}.client-context-message.ok{color:#34d399}.client-context-history{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}.client-context-history-title{font-size:10px;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}.client-context-record{display:grid;grid-template-columns:1fr auto;gap:10px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.10)}.client-context-record:last-child{border-bottom:0}.client-context-record b{font-size:11px}.client-context-record small{display:block;color:var(--muted);font-size:9px;margin-top:3px;line-height:1.4}.client-context-record p{font-size:10px;margin:5px 0 0;line-height:1.45;color:var(--text)}.client-context-view{align-self:center;font-size:10px!important;padding:6px 8px!important}.client-context-empty{color:var(--muted);font-size:10px;padding:8px 0}.client-context-viewer-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.78);z-index:9998}.client-context-viewer{position:fixed;z-index:9999;left:50%;top:50%;transform:translate(-50%,-50%);width:min(880px,92vw);max-height:86vh;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:0 30px 90px rgba(0,0,0,.45);display:flex;flex-direction:column}.client-context-viewer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}.client-context-viewer-head h3{margin:0;font-size:14px}.client-context-viewer-body{padding:16px;overflow:auto}.client-context-viewer pre{white-space:pre-wrap;word-break:break-word;font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;color:var(--text)}.client-context-viewer-summary{margin:0 0 12px;padding:10px;border:1px solid rgba(59,130,246,.2);border-radius:10px;background:rgba(59,130,246,.05);font-size:11px;line-height:1.5}.ops-360-grid>.${SLOT_CLASS},.leo-client-dossier-grid>.${SLOT_CLASS}{grid-column:1/-1}
@media(max-width:720px){.client-context-head{flex-direction:column}.client-context-add{width:100%}.client-context-form-grid{grid-template-columns:1fr}.client-context-record{grid-template-columns:1fr}.client-context-view{justify-self:start}.client-context-viewer{width:94vw}}
`;
  document.head.appendChild(style);
}

function targets() {
  const result: Array<{ root: HTMLElement; anchor: HTMLElement; heading: HTMLElement; kind: string }> = [];
  const drawer = document.querySelector(".drawer.open") as HTMLElement | null;
  const drawerGrid = drawer?.querySelector(".detail-grid") as HTMLElement | null;
  const drawerHeading = drawer?.querySelector(".drawer-head h2") as HTMLElement | null;
  if (drawer && drawerGrid && drawerHeading) result.push({ root: drawer, anchor: drawerGrid, heading: drawerHeading, kind: "drawer" });

  const view360 = document.querySelector(".ops-360") as HTMLElement | null;
  const view360Grid = view360?.querySelector(".ops-360-grid") as HTMLElement | null;
  const view360Heading = view360?.querySelector(".ops-360-head h2") as HTMLElement | null;
  if (view360 && view360Grid && view360Heading) result.push({ root: view360, anchor: view360Grid, heading: view360Heading, kind: "360" });

  const leo = document.querySelector(".leo-client-dossier") as HTMLElement | null;
  const leoGrid = leo?.querySelector(".leo-client-dossier-grid") as HTMLElement | null;
  const leoHeading = leo?.querySelector(".workspace-head h2") as HTMLElement | null;
  if (leo && leoGrid && leoHeading) result.push({ root: leo, anchor: leoGrid, heading: leoHeading, kind: "leonardo" });
  return result;
}

async function openTranscript(name: string, id: number) {
  const backdrop = el("div", "client-context-viewer-backdrop");
  const modal = el("section", "client-context-viewer");
  const head = el("div", "client-context-viewer-head");
  const title = el("h3", "", "Carregando transcrição…");
  const close = el("button", "", "×");
  const body = el("div", "client-context-viewer-body");
  head.append(title, close);
  modal.append(head, body);
  document.body.append(backdrop, modal);
  const dismiss = () => { backdrop.remove(); modal.remove(); };
  backdrop.onclick = dismiss;
  close.onclick = dismiss;
  try {
    const payload = await authenticatedFetch(`${API}?name=${encodeURIComponent(name)}&transcript_id=${id}`);
    const t = payload.transcript || {};
    title.textContent = t.source_file_name || "Transcrição";
    if (t.summary) body.appendChild(el("p", "client-context-viewer-summary", String(t.summary)));
    const pre = el("pre");
    pre.textContent = String(t.transcript_text || "Transcrição indisponível.");
    body.appendChild(pre);
  } catch (error) {
    title.textContent = "Não foi possível abrir";
    body.appendChild(el("p", "client-context-message error", error instanceof Error ? error.message : "Falha ao carregar."));
  }
}

function render(slot: HTMLElement, name: string, payload: HistoryPayload, reload: () => Promise<void>) {
  slot.replaceChildren();
  const records = Array.isArray(payload.records) ? payload.records : [];
  const head = el("div", "client-context-head");
  const headText = el("div");
  headText.append(el("h3", "", "Contexto e registros"), el("p", "", "Salve ligações e reuniões no histórico do cliente. O conteúdo passa a alimentar o contexto operacional e da IA."));
  const add = el("button", "client-context-add", "+ Registrar interação");
  head.append(headText, add);
  slot.appendChild(head);

  const panel = el("div", "client-context-panel");
  const grid = el("div", "client-context-form-grid");
  const typeField = el("label", "client-context-field");
  typeField.appendChild(el("span", "", "Tipo"));
  const type = document.createElement("select");
  [["CALL", "Ligação"], ["MEETING", "Reunião"], ["NOTE", "Outro contexto"]].forEach(([value, label]) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; type.appendChild(option);
  });
  typeField.appendChild(type);
  const contextField = el("label", "client-context-field");
  contextField.appendChild(el("span", "", "Contexto adicional (opcional)"));
  const context = document.createElement("textarea");
  context.placeholder = "Ex.: cliente reclamou no grupo; Joel ligou imediatamente para entender e resolver.";
  contextField.appendChild(context);
  grid.append(typeField, contextField);
  panel.appendChild(grid);

  const correction = el("label", "client-context-field");
  correction.style.marginTop = "9px";
  correction.appendChild(el("span", "", "Data da interação — use apenas para corrigir o metadado do arquivo"));
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  correction.appendChild(dateInput);
  panel.appendChild(correction);

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,.md,text/plain,text/markdown,text/x-markdown";
  input.hidden = true;
  const drop = el("div", "client-context-drop");
  drop.append(el("b", "", "Arraste a transcrição aqui ou clique para escolher"), el("small", "", "Aceita .TXT e .MD · até 2 MB"));
  const fileInfo = el("div", "client-context-file");
  panel.append(input, drop, fileInfo);
  let selected: File | null = null;
  const choose = (file: File) => {
    validateFile(file);
    selected = file;
    fileInfo.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  };
  drop.onclick = () => input.click();
  input.onchange = () => {
    try { if (input.files?.[0]) choose(input.files[0]); }
    catch (error) { selected = null; fileInfo.textContent = error instanceof Error ? error.message : "Arquivo inválido."; }
  };
  drop.ondragover = (event) => { event.preventDefault(); drop.classList.add("drag"); };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = (event) => {
    event.preventDefault(); drop.classList.remove("drag");
    try { if (event.dataTransfer?.files?.[0]) choose(event.dataTransfer.files[0]); }
    catch (error) { selected = null; fileInfo.textContent = error instanceof Error ? error.message : "Arquivo inválido."; }
  };

  const actions = el("div", "client-context-actions");
  const message = el("span", "client-context-message");
  const cancel = el("button", "", "Cancelar");
  const save = el("button", "client-context-add", "Salvar no contexto");
  actions.append(message, cancel, save);
  panel.appendChild(actions);
  slot.appendChild(panel);

  add.onclick = () => panel.classList.toggle("open");
  cancel.onclick = () => { panel.classList.remove("open"); message.textContent = ""; };
  save.onclick = async () => {
    message.className = "client-context-message";
    if (!selected) { message.textContent = "Escolha um arquivo .txt ou .md."; message.classList.add("error"); return; }
    try {
      validateFile(selected);
      save.setAttribute("disabled", "true");
      save.textContent = "Salvando…";
      message.textContent = "Lendo e vinculando ao cliente…";
      const content = await selected.text();
      const payload = await authenticatedFetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: name,
          file_name: selected.name,
          mime_type: selected.type || (selected.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain"),
          content,
          interaction_type: type.value,
          context: context.value.trim(),
          occurred_at: dateInput.value ? `${dateInput.value}T12:00:00-03:00` : null,
        }),
      });
      message.textContent = payload.duplicate ? "Esse conteúdo já estava salvo neste cliente." : "Transcrição salva e adicionada ao contexto.";
      message.classList.add("ok");
      selected = null;
      input.value = "";
      fileInfo.textContent = "";
      context.value = "";
      dateInput.value = "";
      await reload();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "Não foi possível salvar.";
      message.classList.add("error");
    } finally {
      save.removeAttribute("disabled");
      save.textContent = "Salvar no contexto";
    }
  };

  const history = el("div", "client-context-history");
  history.appendChild(el("div", "client-context-history-title", `Ligações e reuniões · ${records.length ? `últimas ${records.length}` : "sem registros"}`));
  if (!records.length) history.appendChild(el("div", "client-context-empty", "Nenhuma transcrição vinculada a este cliente ainda."));
  records.forEach((record) => {
    const row = el("div", "client-context-record");
    const main = el("div");
    const fileName = String(record.source_file_name || sourceLabel(record.source_system));
    main.appendChild(el("b", "", fileName));
    main.appendChild(el("small", "", `${sourceLabel(record.source_system)} · ${formatDate(record.meeting_started_at || record.created_at)} · ${Number(record.transcript_chars || 0).toLocaleString("pt-BR")} caracteres`));
    if (record.summary) main.appendChild(el("p", "", String(record.summary).slice(0, 420)));
    const view = el("button", "client-context-view", "Ver transcrição");
    view.onclick = () => { void openTranscript(name, Number(record.id)); };
    row.append(main, view);
    history.appendChild(row);
  });
  slot.appendChild(history);
}

export default function ClientContextUploadBridge() {
  useEffect(() => {
    ensureStyle();
    let active = true;
    let scanning = false;
    const cache = new Map<string, { at: number; payload: HistoryPayload }>();

    async function load(name: string, force = false): Promise<HistoryPayload | null> {
      const cached = cache.get(name);
      if (!force && cached && Date.now() - cached.at < 20_000) return cached.payload;
      try {
        const payload = await authenticatedFetch(`${API}?name=${encodeURIComponent(name)}`);
        cache.set(name, { at: Date.now(), payload });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/não tem acesso|Cliente não encontrado/i.test(message)) return null;
        throw error;
      }
    }

    async function scan() {
      if (!active || scanning) return;
      scanning = true;
      try {
        for (const target of targets()) {
          const name = (target.heading.textContent || "").trim();
          if (!name || /carregando|buscando/i.test(name)) continue;
          let slot = target.anchor.querySelector(`:scope > .${SLOT_CLASS}`) as HTMLElement | null;
          if (!slot) {
            slot = document.createElement("section");
            slot.className = SLOT_CLASS;
            target.anchor.appendChild(slot);
          }
          const key = `${target.kind}:${name}`;
          if (slot.dataset.contextKey === key && slot.dataset.contextState === "ready") continue;
          slot.dataset.contextKey = key;
          slot.dataset.contextState = "loading";
          slot.replaceChildren(el("span", "client-context-message", "Carregando contexto do cliente…"));
          try {
            const payload = await load(name);
            if (!active || slot.dataset.contextKey !== key) continue;
            if (!payload) { slot.remove(); continue; }
            const reload = async () => {
              const next = await load(name, true);
              if (!active || !next || slot.dataset.contextKey !== key) return;
              render(slot!, name, next, reload);
              slot!.dataset.contextState = "ready";
            };
            render(slot, name, payload, reload);
            slot.dataset.contextState = "ready";
          } catch (error) {
            if (!active || slot.dataset.contextKey !== key) continue;
            slot.replaceChildren(el("span", "client-context-message error", error instanceof Error ? error.message : "Não foi possível carregar o contexto."));
            slot.dataset.contextState = "error";
          }
        }
      } finally {
        scanning = false;
      }
    }

    void scan();
    const observer = new MutationObserver(() => { void scan(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = window.setInterval(() => { void scan(); }, 1400);
    return () => {
      active = false;
      observer.disconnect();
      window.clearInterval(timer);
      document.querySelectorAll(`.${SLOT_CLASS}`).forEach((node) => node.remove());
      document.querySelectorAll(".client-context-viewer,.client-context-viewer-backdrop").forEach((node) => node.remove());
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);
  return null;
}
