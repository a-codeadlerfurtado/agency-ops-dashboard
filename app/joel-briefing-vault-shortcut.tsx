"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import BriefingAccessesPanel from "./briefing-accesses-panel";
import { authenticatedFetch, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;

const API = `${SUPABASE_URL}/functions/v1/agency-ops-briefing-staff-api`;
const JOEL = "Joel Antoniete";
const BUTTON_CLASS = "joel-briefing-vault-shortcut";

export default function JoelBriefingVaultShortcut() {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadAccess = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const url = new URL(API);
      url.searchParams.set("action", "bootstrap");
      const response = await authenticatedFetch(url, { cache: "no-store" });
      const body: Row = await response.json().catch(() => ({}));
      const isJoel = response.ok && String(body.person || "") === JOEL;
      setAllowed(isJoel);
      if (!isJoel) {
        setClients([]);
        setSelectedId("");
        setOpen(false);
        return;
      }
      const rows = Array.isArray(body.clients) ? body.clients : [];
      setClients(rows);
      setSelectedId((current) => current && rows.some((client: Row) => String(client.id) === current)
        ? current
        : String(rows[0]?.id || ""));
    } catch {
      setAllowed(false);
      setClients([]);
      setSelectedId("");
      setOpen(false);
      setError("Não foi possível carregar o Cofre de acessos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccess();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setAllowed(false);
        setClients([]);
        setSelectedId("");
        setOpen(false);
        return;
      }
      if (event === "SIGNED_IN" || event === "USER_UPDATED" || event === "TOKEN_REFRESHED") {
        window.setTimeout(() => { void loadAccess(); }, 0);
      }
    });
    return () => subscription.unsubscribe();
  }, [loadAccess]);

  useEffect(() => {
    if (!allowed) return;

    const handleOpen = () => {
      setOpen(true);
      void loadAccess();
    };

    const attach = () => {
      const menu = document.querySelector<HTMLElement>(".profile-menu");
      if (!menu || menu.querySelector(`.${BUTTON_CLASS}`)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.textContent = "Cofre de acessos";
      button.title = "Logins e senhas do Briefing Hub";
      button.addEventListener("click", handleOpen);
      const logout = Array.from(menu.querySelectorAll("button")).find((node) => /sair/i.test(node.textContent || ""));
      if (logout) menu.insertBefore(button, logout);
      else menu.appendChild(button);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((node) => node.remove());
    };
  }, [allowed, loadAccess]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return clients;
    return clients.filter((client) => String(client.display_name || "").toLowerCase().includes(needle));
  }, [clients, query]);

  const selected = clients.find((client) => String(client.id) === selectedId) || null;

  if (!allowed || typeof document === "undefined") return null;

  return <>
    <style>{`
      .${BUTTON_CLASS}{font-weight:650!important;color:#dbeafe!important}
      .joel-vault-bg{position:fixed;inset:0;z-index:2147483200;background:rgba(2,6,12,.76);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:22px}
      .joel-vault{width:min(1180px,calc(100vw - 36px));height:min(780px,calc(100dvh - 36px));background:#0b1116;border:1px solid #2c3942;border-radius:22px;box-shadow:0 30px 100px rgba(0,0,0,.55);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;color:#edf4f8}
      .joel-vault-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:20px 22px;border-bottom:1px solid #25323a;background:linear-gradient(180deg,#111a20,#0d1419)}
      .joel-vault-kicker{font:900 10px Inter,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#ff9557}.joel-vault-head h2{margin:5px 0 4px;font:800 25px/1.1 Inter Tight,Inter,sans-serif}.joel-vault-head p{margin:0;color:#91a1ab;font-size:11px}
      .joel-vault-close{border:1px solid #36454f;background:#151e24;color:#eaf2f6;border-radius:10px;padding:9px 12px;font:750 11px Inter,sans-serif;cursor:pointer}
      .joel-vault-body{display:grid;grid-template-columns:330px minmax(0,1fr);min-height:0}.joel-vault-side{border-right:1px solid #25323a;padding:14px;overflow:auto;background:#0c1318}.joel-vault-main{padding:18px;overflow:auto;min-width:0}
      .joel-vault-search{width:100%;box-sizing:border-box;border:1px solid #33424c;background:#091015;color:#edf4f8;border-radius:10px;padding:10px 11px;outline:none;margin-bottom:10px}.joel-vault-search:focus{border-color:#ff8a46}
      .joel-vault-client{width:100%;display:block;text-align:left;border:1px solid #293740;background:#11191e;color:#dce6eb;border-radius:11px;padding:11px 12px;margin-bottom:7px;cursor:pointer}.joel-vault-client:hover{border-color:#50636e}.joel-vault-client.active{border-color:#ff7a2f;background:rgba(255,122,47,.10)}.joel-vault-client b{display:block;font-size:12px}.joel-vault-client span{display:block;margin-top:4px;color:#82919b;font-size:9px;text-transform:uppercase;letter-spacing:.06em}
      .joel-vault-empty{border:1px dashed #34434d;border-radius:13px;padding:28px;text-align:center;color:#8f9da7;font-size:11px}.joel-vault-error{border:1px solid #6d3030;background:rgba(125,35,35,.12);border-radius:10px;padding:10px;color:#ffaaaa;font-size:11px;margin-bottom:10px}
      @media(max-width:820px){.joel-vault{width:calc(100vw - 18px);height:calc(100dvh - 18px)}.joel-vault-body{grid-template-columns:1fr;grid-template-rows:220px minmax(0,1fr)}.joel-vault-side{border-right:0;border-bottom:1px solid #25323a}.joel-vault-head{padding:15px}.joel-vault-main{padding:12px}}
    `}</style>
    {open && createPortal(
      <div className="joel-vault-bg" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <section className="joel-vault" role="dialog" aria-modal="true" aria-label="Cofre de acessos do Briefing Hub">
          <header className="joel-vault-head">
            <div>
              <div className="joel-vault-kicker">Briefing Hub · Segurança</div>
              <h2>Cofre de acessos</h2>
              <p>Logins e senhas dos clientes do Briefing Hub. A revelação exige a senha do próprio perfil do Joel e fica auditada.</p>
            </div>
            <button className="joel-vault-close" onClick={() => setOpen(false)}>Fechar</button>
          </header>
          <div className="joel-vault-body">
            <aside className="joel-vault-side">
              <input className="joel-vault-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente…" autoFocus />
              {loading && !clients.length && <div className="joel-vault-empty">Carregando clientes…</div>}
              {!loading && !filtered.length && <div className="joel-vault-empty">Nenhum cliente encontrado.</div>}
              {filtered.map((client) => <button key={String(client.id)} className={`joel-vault-client${String(client.id) === selectedId ? " active" : ""}`} onClick={() => setSelectedId(String(client.id))}>
                <b>{String(client.display_name || "Cliente")}</b>
                <span>{String(client.lifecycle || "")}</span>
              </button>)}
            </aside>
            <main className="joel-vault-main">
              {error && <div className="joel-vault-error">{error}</div>}
              {!selected && !loading && <div className="joel-vault-empty">Selecione um cliente para visualizar o acesso.</div>}
              {selected && <BriefingAccessesPanel clientId={String(selected.id)} clientName={String(selected.display_name || "Cliente")} drive={selected.drive || null} />}
            </main>
          </div>
        </section>
      </div>,
      document.body,
    )}
  </>;
}
