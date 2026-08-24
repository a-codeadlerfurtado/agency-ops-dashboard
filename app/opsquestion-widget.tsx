"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, WORK_ITEM_CREATE_API, authenticatedFetch, isSessionExpiredError, supabase } from "./shared";

const ASK_URL = `${SUPABASE_URL}/functions/v1/agency-ops-ai-ask-team-v5`;

type SuggestedAction = {
  id: string;
  title: string;
  description: string;
  client_id: string | null;
  client_name: string | null;
  target_role: string | null;
  target_person: string | null;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  type: "ESCALATION" | "CREATIVE_REQUEST" | "TECHNICAL" | "CLIENT_FOLLOWUP" | "CLICKUP" | "FINANCE" | "GENERAL";
  create_clickup?: boolean;
  source?: string;
  source_id?: string | null;
  executing?: boolean;
  executed?: boolean;
  error?: string | null;
};

type ChatMessage = {
  role: "user" | "ai";
  text: string;
  source?: string;
  latencyMs?: number;
  originQuestion?: string;
  requestId?: string;
  actions?: SuggestedAction[];
};

const priorityLabel: Record<string, string> = {
  CRITICAL: "Crítica",
  HIGH: "Alta",
  MEDIUM: "Média",
  LOW: "Baixa",
};

const roleLabel: Record<string, string> = {
  GT: "GT",
  CS: "CS",
  DESIGN: "Design",
  MGMT: "Operações",
  AI: "IA",
};

export default function OpsQuestionWidget() {
  const [session, setSession] = useState<Session | null>(null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSession(data.session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      if (mounted) setSession(next);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking, open]);

  async function send() {
    const q = question.trim();
    if (!q || asking) return;

    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setQuestion("");
    setAsking(true);

    try {
      const controller = new AbortController();
      // O backend possui limite próprio; este teto protege o navegador contra requests órfãos.
      const timeout = window.setTimeout(() => controller.abort(), 110_000);
      let response: Response;
      try {
        response = await authenticatedFetch(ASK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q }),
          cache: "no-store",
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }

      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        const detail = json?.error || json?.detail || `OpsQuestion indisponível (${response.status}).`;
        setMessages((prev) => [...prev, { role: "ai", text: String(detail) }]);
      } else {
        const actions: SuggestedAction[] = Array.isArray(json.suggested_actions)
          ? json.suggested_actions.slice(0, 3).map((action: SuggestedAction) => ({ ...action, executing: false, executed: false, error: null }))
          : [];
        setMessages((prev) => [...prev, {
          role: "ai",
          text: String(json.answer || "Sem resposta."),
          source: json.source || "Base operacional",
          latencyMs: Number(json.latency_ms || 0) || undefined,
          originQuestion: q,
          requestId: json.request_id || undefined,
          actions,
        }]);
      }
    } catch (error) {
      if (isSessionExpiredError(error)) {
        setMessages((prev) => [...prev, {
          role: "ai",
          text: "Sua sessão expirou. Entre novamente no dashboard para continuar usando o OpsQuestion.",
        }]);
      } else if (error instanceof DOMException && error.name === "AbortError") {
        setMessages((prev) => [...prev, {
          role: "ai",
          text: "Essa consulta passou do tempo de resposta. Tente novamente — não precisa reformular a pergunta.",
        }]);
      } else {
        setMessages((prev) => [...prev, {
          role: "ai",
          text: "Falha temporária ao consultar o OpsQuestion. Tente novamente.",
        }]);
      }
    } finally {
      setAsking(false);
    }
  }

  function patchAction(messageIndex: number, actionIndex: number, patch: Partial<SuggestedAction>) {
    setMessages((prev) => prev.map((message, mi) => {
      if (mi !== messageIndex || !message.actions) return message;
      return {
        ...message,
        actions: message.actions.map((action, ai) => ai === actionIndex ? { ...action, ...patch } : action),
      };
    }));
  }

  async function executeAction(messageIndex: number, actionIndex: number) {
    const message = messages[messageIndex];
    const action = message?.actions?.[actionIndex];
    if (!action || action.executing || action.executed) return;

    const destination = action.target_person || roleLabel[action.target_role || ""] || "Operações";
    const clientText = action.client_name ? ` para ${action.client_name}` : "";
    const clickupText = action.create_clickup ? " Também será criada a task correspondente no ClickUp." : "";
    const approved = window.confirm(
      `Criar esta ação operacional${clientText}?\n\n${action.title}\n\nResponsável: ${destination}\nPrioridade: ${priorityLabel[action.priority] || action.priority}\n\nIsso cria uma solicitação interna para o responsável. Não pausa campanhas nem envia mensagens ao cliente automaticamente.${clickupText}`
    );
    if (!approved) return;

    patchAction(messageIndex, actionIndex, { executing: true, error: null });
    try {
      const response = await authenticatedFetch(WORK_ITEM_CREATE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: action.title,
          description: [
            action.description,
            "",
            `Origem: OpsQuestion${message.requestId ? ` · ${message.requestId}` : ""}`,
            message.originQuestion ? `Pergunta que originou a ação: ${message.originQuestion}` : null,
          ].filter(Boolean).join("\n"),
          client_id: action.client_id,
          type: action.type,
          priority: action.priority,
          target_role: action.target_role,
          target_person: action.target_person,
          create_clickup: Boolean(action.create_clickup),
          source: "opsquestion_v5_2",
          source_id: action.source_id || message.requestId || action.id,
          metadata: {
            opsquestion_action_id: action.id,
            opsquestion_request_id: message.requestId || null,
            original_question: message.originQuestion || null,
            generated_from_next_steps: true,
            execution_mode: "CREATE_WORK_ITEM",
          },
        }),
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(String(result?.detail || result?.error || `Falha ${response.status}`));
      patchAction(messageIndex, actionIndex, { executing: false, executed: true, error: null });
    } catch (error) {
      patchAction(messageIndex, actionIndex, { executing: false, error: error instanceof Error ? error.message : "Falha ao criar ação." });
    }
  }

  if (!session) return null;

  return (
    <aside style={{ position: "fixed", right: 18, bottom: 18, zIndex: 10050, width: open ? "min(460px,calc(100vw - 36px))" : "auto", fontFamily: "inherit" }}>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Abrir OpsQuestion"
          style={{ background: "rgba(9,12,20,.96)", color: "#f8fafc", border: "1px solid rgba(115,167,255,.28)", borderRadius: 999, padding: "10px 15px", display: "flex", alignItems: "center", gap: 9, cursor: "pointer", boxShadow: "0 16px 50px rgba(0,0,0,.32)", backdropFilter: "blur(16px)" }}
        >
          <span style={{ width: 24, height: 24, borderRadius: 999, display: "grid", placeItems: "center", background: "rgba(59,130,246,.18)", color: "#93c5fd", fontWeight: 900 }}>✦</span>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.05 }}>
            <b style={{ fontSize: 12.5 }}>OpsQuestion</b>
            <small style={{ marginTop: 3, color: "#7f93ad", fontSize: 9.5 }}>IA OPERACIONAL</small>
          </span>
        </button>
      )}

      {open && (
        <div style={{ height: "min(620px,calc(100vh - 56px))", background: "rgba(7,13,23,.98)", color: "#f8fafc", borderRadius: 17, border: "1px solid rgba(115,167,255,.22)", boxShadow: "0 24px 80px rgba(0,0,0,.44)", display: "flex", flexDirection: "column", overflow: "hidden", backdropFilter: "blur(20px)" }}>
          <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 13px", borderBottom: "1px solid rgba(148,163,184,.13)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 28, height: 28, borderRadius: 9, display: "grid", placeItems: "center", background: "rgba(59,130,246,.16)", color: "#93c5fd", fontWeight: 900 }}>✦</span>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <b style={{ fontSize: 13 }}>OpsQuestion</b>
                <small style={{ color: "#718399", fontSize: 9.5, marginTop: 2 }}>Inteligência operacional · ações sob confirmação</small>
              </span>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Minimizar OpsQuestion" style={{ border: 0, background: "transparent", color: "#94a3b8", fontSize: 20, cursor: "pointer", padding: "2px 6px" }}>−</button>
          </header>

          <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 9 }}>
            {!messages.length && (
              <div style={{ border: "1px solid rgba(115,167,255,.13)", background: "rgba(59,130,246,.055)", borderRadius: 12, padding: 11, color: "#a9b7ca", fontSize: 12, lineHeight: 1.5 }}>
                Pergunte sobre clientes, campanhas, onboarding, WhatsApp, saúde, comercial, produtividade ou riscos. Quando houver um plano, você poderá criar a ação operacional pela própria resposta após confirmar.
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
                  {["Quem precisa de atenção hoje?", "Se você fosse o Adler, quais decisões tomaria amanhã?", "Qual gargalo está piorando semana a semana?"].map((item) => (
                    <button key={item} onClick={() => setQuestion(item)} style={{ border: "1px solid rgba(148,163,184,.14)", background: "rgba(255,255,255,.025)", color: "#cbd5e1", borderRadius: 999, padding: "5px 8px", fontSize: 10.5, cursor: "pointer" }}>{item}</button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <div key={index} style={{ alignSelf: message.role === "user" ? "flex-end" : "flex-start", maxWidth: message.role === "ai" ? "96%" : "90%" }}>
                <div style={{ background: message.role === "user" ? "#2563eb" : "#141e2d", border: message.role === "ai" ? "1px solid rgba(148,163,184,.1)" : "none", color: "#f8fafc", borderRadius: message.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", padding: "8px 10px", fontSize: 12.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{message.text}</div>

                {message.role === "ai" && message.actions && message.actions.length > 0 && (
                  <div style={{ marginTop: 7, display: "grid", gap: 6 }}>
                    <div style={{ fontSize: 9.5, color: "#7f93ad", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em" }}>Ações sugeridas</div>
                    {message.actions.map((action, actionIndex) => (
                      <div key={action.id} style={{ border: "1px solid rgba(96,165,250,.18)", background: "rgba(15,23,42,.78)", borderRadius: 10, padding: 9 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.35, color: "#e5edf8" }}>{action.title}</div>
                        <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
                          {action.client_name && <span style={{ fontSize: 9.5, color: "#a9b7ca", background: "rgba(148,163,184,.08)", borderRadius: 999, padding: "3px 6px" }}>{action.client_name}</span>}
                          <span style={{ fontSize: 9.5, color: "#a9b7ca", background: "rgba(148,163,184,.08)", borderRadius: 999, padding: "3px 6px" }}>{action.target_person || roleLabel[action.target_role || ""] || "Operações"}</span>
                          <span style={{ fontSize: 9.5, color: "#a9b7ca", background: "rgba(148,163,184,.08)", borderRadius: 999, padding: "3px 6px" }}>{priorityLabel[action.priority] || action.priority}</span>
                          {action.create_clickup && <span style={{ fontSize: 9.5, color: "#93c5fd", background: "rgba(59,130,246,.12)", borderRadius: 999, padding: "3px 6px" }}>+ ClickUp</span>}
                          <button
                            onClick={() => executeAction(index, actionIndex)}
                            disabled={action.executing || action.executed}
                            style={{ marginLeft: "auto", border: "1px solid rgba(96,165,250,.3)", background: action.executed ? "rgba(34,197,94,.12)" : "rgba(37,99,235,.18)", color: action.executed ? "#86efac" : "#bfdbfe", borderRadius: 8, padding: "5px 8px", fontSize: 10, fontWeight: 700, cursor: action.executing || action.executed ? "default" : "pointer", opacity: action.executing ? .65 : 1 }}
                          >
                            {action.executed ? "Ação criada ✓" : action.executing ? "Criando…" : "Criar ação"}
                          </button>
                        </div>
                        {action.error && <div style={{ marginTop: 5, color: "#fca5a5", fontSize: 9.5 }}>{action.error}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {message.role === "ai" && message.source && <small style={{ display: "block", color: "#617188", fontSize: 9.5, marginTop: 4, paddingLeft: 2 }}>Fonte: {message.source}{message.latencyMs ? ` · ${(message.latencyMs / 1000).toFixed(1)}s` : ""}</small>}
              </div>
            ))}
            {asking && <div style={{ alignSelf: "flex-start", color: "#8ea0b7", fontSize: 11.5, padding: "7px 9px", background: "#101a28", borderRadius: "10px 10px 10px 3px" }}>Cruzando evidências da operação…</div>}
            <div ref={endRef} />
          </div>

          <footer style={{ padding: 10, borderTop: "1px solid rgba(148,163,184,.13)" }}>
            <div style={{ display: "flex", gap: 7 }}>
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
                placeholder="Pergunte ao OpsQuestion…"
                maxLength={2500}
                style={{ flex: 1, minWidth: 0, background: "#0e1826", border: "1px solid rgba(148,163,184,.15)", borderRadius: 10, color: "#f8fafc", padding: "9px 10px", outline: "none", fontSize: 12.5 }}
              />
              <button onClick={send} disabled={asking || !question.trim()} style={{ background: "#2563eb", border: 0, borderRadius: 10, color: "white", padding: "9px 13px", fontSize: 12, fontWeight: 700, cursor: asking || !question.trim() ? "default" : "pointer", opacity: asking || !question.trim() ? .5 : 1 }}>Enviar</button>
            </div>
          </footer>
        </div>
      )}
    </aside>
  );
}