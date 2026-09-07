"use client";

/**
 * JarvisVoice -- microfone, streaming e fala, por cima do OpsQuestion.
 *
 * Monta ao lado do widget e nao toca no fluxo de texto dele: quem digita
 * continua usando /api/ai como sempre. Este componente fala com /api/jarvis.
 *
 * Duas decisoes que valem explicacao:
 *
 *  - A fala e enfileirada FRASE A FRASE conforme os tokens chegam, nao no fim.
 *    Esperar a resposta inteira antes de abrir a boca acrescenta o tempo do
 *    modelo ao tempo da fala, e a conversa fica com cara de radio via satelite.
 *
 *  - Nada de localStorage. A pendencia vive no servidor com validade de 15 min;
 *    guardar copia no navegador so criaria divergencia entre o que a tela mostra
 *    e o que o banco aceita executar.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./shared";

type Linha =
  | { tipo: "usuario"; texto: string }
  | { tipo: "jarvis"; texto: string }
  | { tipo: "ferramenta"; texto: string };

type Pendencia = { id: string; resumo: string };

const FIM_DE_FRASE = /(?<=[.!?\n])\s+/;

/** Voz feminina pt-BR, com as preferidas primeiro. */
function escolherVoz(): SpeechSynthesisVoice | null {
  const vozes = window.speechSynthesis?.getVoices?.() ?? [];
  const brasileiras = vozes.filter((v) => v.lang?.toLowerCase().startsWith("pt-br"));
  if (!brasileiras.length) return null;
  const preferida = brasileiras.find((v) => /natural|francisca|maria/i.test(v.name));
  return preferida ?? brasileiras[0];
}

export default function JarvisVoice() {
  const [ativo, setAtivo] = useState(false);
  const [ouvindo, setOuvindo] = useState(false);
  const [falando, setFalando] = useState(false);
  const [parcial, setParcial] = useState("");
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [pendencia, setPendencia] = useState<Pendencia | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [liberado, setLiberado] = useState(false);

  const conversaRef = useRef<string | null>(null);
  const reconhecimentoRef = useRef<any>(null);
  const vozRef = useRef<SpeechSynthesisVoice | null>(null);
  const bufferFalaRef = useRef("");

  // Rollout: MGMT primeiro. O projeto nao tem feature flag, entao a trava e o
  // proprio RBAC. Nao e barreira de seguranca -- o servidor ja filtra as
  // ferramentas por papel -- e so para nao expor a Jarvis antes da validacao.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const ops = supabase.schema("agency_ops");
      const { data: pref } = await ops.from("user_preferences").select("collaborator_person").limit(1).maybeSingle();
      const pessoa = pref?.collaborator_person;
      if (!pessoa) return;
      const { data: cadastro } = await ops.from("team_roster").select("role").eq("person", pessoa).maybeSingle();
      if (vivo && cadastro?.role === "MGMT") setLiberado(true);
    })();
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    const carregar = () => { vozRef.current = escolherVoz(); };
    carregar();
    window.speechSynthesis?.addEventListener?.("voiceschanged", carregar);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", carregar);
  }, []);

  const falar = useCallback((texto: string) => {
    const limpo = texto.trim();
    if (!limpo || !window.speechSynthesis) return;
    const fala = new SpeechSynthesisUtterance(limpo);
    fala.lang = "pt-BR";
    if (vozRef.current) fala.voice = vozRef.current;
    fala.rate = 1.05;
    fala.onstart = () => setFalando(true);
    fala.onend = () => setFalando(window.speechSynthesis.speaking);
    window.speechSynthesis.speak(fala);
  }, []);

  const calar = useCallback(() => {
    window.speechSynthesis?.cancel();
    setFalando(false);
    bufferFalaRef.current = "";
  }, []);

  const enviar = useCallback(async (mensagem: string) => {
    const texto = mensagem.trim();
    if (!texto) return;
    setErro(null);
    setParcial("");
    setLinhas((atual) => [...atual, { tipo: "usuario", texto }]);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { setErro("sessão expirada"); return; }

    let resposta: Response;
    try {
      resposta = await fetch("/api/jarvis/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversaRef.current, message: texto, voice: true }),
      });
    } catch {
      setErro("não consegui falar com o servidor");
      return;
    }
    if (!resposta.ok || !resposta.body) { setErro(`falhou (${resposta.status})`); return; }

    setLinhas((atual) => [...atual, { tipo: "jarvis", texto: "" }]);
    const leitor = resposta.body.getReader();
    const decodificador = new TextDecoder();
    let sobra = "";

    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      sobra += decodificador.decode(value, { stream: true });
      const blocos = sobra.split("\n\n");
      sobra = blocos.pop() ?? "";

      for (const bloco of blocos) {
        const evento = /^event:\s*(.+)$/m.exec(bloco)?.[1]?.trim();
        const bruto = /^data:\s*(.+)$/m.exec(bloco)?.[1];
        if (!evento || !bruto) continue;
        let dados: any; try { dados = JSON.parse(bruto); } catch { continue; }

        if (evento === "tool_start") {
          setLinhas((a) => [...a, { tipo: "ferramenta", texto: dados.summary || dados.name }]);
        } else if (evento === "token") {
          setLinhas((a) => {
            const copia = [...a];
            for (let i = copia.length - 1; i >= 0; i--) {
              if (copia[i].tipo === "jarvis") { copia[i] = { tipo: "jarvis", texto: copia[i].texto + dados.text }; break; }
            }
            return copia;
          });
          // fala o que ja fecha frase; o resto espera o proximo token
          bufferFalaRef.current += dados.text;
          const partes = bufferFalaRef.current.split(FIM_DE_FRASE);
          bufferFalaRef.current = partes.pop() ?? "";
          for (const parte of partes) falar(parte);
        } else if (evento === "pending") {
          setPendencia({ id: dados.action_id, resumo: dados.summary });
          falar(`${dados.summary}. Confirmo?`);
        } else if (evento === "error") {
          setErro(String(dados.message ?? "erro"));
        }
      }
    }
    if (bufferFalaRef.current.trim()) { falar(bufferFalaRef.current); bufferFalaRef.current = ""; }
  }, [falar]);

  const resolver = useCallback(async (decisao: "confirm" | "cancel") => {
    if (!pendencia) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await fetch("/api/jarvis/confirm", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action_id: pendencia.id, decision: decisao }),
    }).catch(() => null);
    const corpo = await r?.json().catch(() => null);
    const dito = String(corpo?.result_text ?? "Não consegui resolver isso.");
    setPendencia(null);
    setLinhas((a) => [...a, { tipo: "jarvis", texto: dito }]);
    falar(dito);
  }, [pendencia, falar]);

  const ouvir = useCallback(() => {
    calar(); // interrompe a fala assim que o mic liga
    const Reconhecimento = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Reconhecimento) { setErro("este navegador não reconhece voz; use o campo de texto"); return; }

    const r = new Reconhecimento();
    r.lang = "pt-BR";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (evento: any) => {
      let final = "", provisorio = "";
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        const t = evento.results[i][0].transcript;
        if (evento.results[i].isFinal) final += t; else provisorio += t;
      }
      setParcial(provisorio);
      if (final) { setOuvindo(false); r.stop(); void enviar(final); }
    };
    r.onerror = () => { setOuvindo(false); setErro("não consegui ouvir"); };
    r.onend = () => setOuvindo(false);
    reconhecimentoRef.current = r;
    setOuvindo(true);
    r.start();
  }, [calar, enviar]);

  const alternar = useCallback(() => {
    if (ouvindo) { reconhecimentoRef.current?.stop?.(); setOuvindo(false); return; }
    if (!ativo) setAtivo(true);
    ouvir();
  }, [ouvindo, ativo, ouvir]);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Space") { e.preventDefault(); alternar(); }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [alternar]);

  if (!liberado) return null;

  if (!ativo && !linhas.length) {
    return (
      <button
        type="button"
        onClick={alternar}
        title="Falar com a Jarvis (Ctrl+Espaço)"
        aria-label="Falar com a Jarvis"
        style={botaoFlutuante}
      >
        🎙
      </button>
    );
  }

  return (
    <div style={painel}>
      <div style={cabecalho}>
        <span className={`opsq-cinematic-core ${falando ? "is-speaking" : ""}`} style={nucleo} aria-hidden="true" />
        <strong style={{ fontSize: 13 }}>Jarvis</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
          {ouvindo ? "ouvindo…" : falando ? "falando…" : "Ctrl+Espaço"}
        </span>
        <button type="button" onClick={() => { calar(); setAtivo(false); }} style={fechar} aria-label="Fechar">×</button>
      </div>

      <div style={corpo}>
        {linhas.map((linha, i) => (
          <div key={i} style={linhaEstilo(linha.tipo)}>
            {linha.tipo === "ferramenta" ? `· ${linha.texto}…` : linha.texto}
          </div>
        ))}
        {parcial && <div style={{ ...linhaEstilo("usuario"), opacity: 0.5 }}>{parcial}</div>}
        {erro && <div style={{ color: "var(--red)", fontSize: 12 }}>{erro}</div>}
      </div>

      {pendencia && (
        <div style={cartaoPendencia}>
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>{pendencia.resumo}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => resolver("confirm")} style={botaoConfirmar}>Confirmar</button>
            <button type="button" onClick={() => resolver("cancel")} style={botaoCancelar}>Cancelar</button>
          </div>
        </div>
      )}

      <button type="button" onClick={alternar} style={{ ...micNoPainel, ...(ouvindo ? micAtivo : null) }}>
        {ouvindo ? "Parar" : "🎙 Falar"}
      </button>
    </div>
  );
}

/* estilos inline: o componente e um enxerto no OpsQuestion, nao tem folha propria */

const botaoFlutuante: React.CSSProperties = {
  position: "fixed", right: 22, bottom: 92, zIndex: 30,
  width: 46, height: 46, borderRadius: "50%", cursor: "pointer",
  border: "1px solid var(--line)", background: "var(--panel)", color: "var(--text)",
  fontSize: 18, boxShadow: "var(--shadow)",
};

const painel: React.CSSProperties = {
  position: "fixed", right: 22, bottom: 92, zIndex: 30,
  width: "min(360px, calc(100vw - 44px))", maxHeight: "min(60vh, 520px)",
  display: "flex", flexDirection: "column", gap: 10, padding: 14,
  borderRadius: 16, border: "1px solid var(--line)", background: "var(--panel)",
  color: "var(--text)", boxShadow: "var(--shadow)",
};

const cabecalho: React.CSSProperties = { display: "flex", alignItems: "center", gap: 9 };
const nucleo: React.CSSProperties = { width: 16, height: 16, borderRadius: "50%", background: "var(--brand)", display: "inline-block" };
const fechar: React.CSSProperties = { border: 0, background: "transparent", color: "var(--muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 };
const corpo: React.CSSProperties = { flex: 1, overflowY: "auto", display: "grid", gap: 7, fontSize: 13, lineHeight: 1.5 };

function linhaEstilo(tipo: Linha["tipo"]): React.CSSProperties {
  if (tipo === "usuario") return { color: "var(--muted)" };
  if (tipo === "ferramenta") return { color: "var(--muted)", fontSize: 11.5, fontStyle: "italic" };
  return { color: "var(--text)" };
}

const cartaoPendencia: React.CSSProperties = {
  padding: 11, borderRadius: 11,
  border: "1px solid rgba(242,107,33,.35)", background: "var(--accent-soft)",
};
const botaoConfirmar: React.CSSProperties = {
  flex: 1, padding: "8px 10px", borderRadius: 9, border: 0,
  background: "var(--accent)", color: "#1a0c02", fontWeight: 800, cursor: "pointer",
};
const botaoCancelar: React.CSSProperties = {
  flex: 1, padding: "8px 10px", borderRadius: 9,
  border: "1px solid var(--line)", background: "transparent", color: "var(--text)", cursor: "pointer",
};
const micNoPainel: React.CSSProperties = {
  padding: "9px 12px", borderRadius: 10, cursor: "pointer",
  border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--text)",
};
const micAtivo: React.CSSProperties = { borderColor: "var(--accent)", color: "var(--accent)" };
