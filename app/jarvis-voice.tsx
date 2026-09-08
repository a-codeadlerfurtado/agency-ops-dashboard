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
 *  - O unico estado persistido no navegador e o ID opaco da conversa, por usuario.
 *    Mensagens, pendencias e dados operacionais continuam server-owned; assim voz e
 *    texto retomam o mesmo contexto sem duplicar dados sensiveis no browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./shared";

type Linha =
  | { tipo: "usuario"; texto: string }
  | { tipo: "jarvis"; texto: string }
  | { tipo: "ferramenta"; texto: string };

type Pendencia = { id: string; resumo: string };

type Estado = "inativo" | "ouvindo" | "analisando" | "respondendo";

const ROTULO_ESTADO: Record<Estado, string> = {
  inativo: "Pronto",
  ouvindo: "Estou ouvindo…",
  analisando: "Analisando…",
  respondendo: "Respondendo…",
};

// Verde ouvindo, ambar processando, azul falando -- tres cores que ja existem
// nos tokens do dashboard, nenhuma inventada.
const COR_ESTADO: Record<Estado, string> = {
  inativo: "var(--muted)",
  ouvindo: "var(--green)",
  analisando: "var(--yellow)",
  respondendo: "var(--blue)",
};

const PULSO_CSS = `
.jv-orbe{position:relative;flex:none}
.jv-pulsa::after{content:"";position:absolute;inset:-6px;border-radius:50%;
  border:1px solid currentColor;opacity:0;animation:jvPulso 1.6s ease-out infinite}
.jv-onda{display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;
  background:currentColor;animation:jvOnda .9s ease-in-out infinite}
@keyframes jvPulso{0%{transform:scale(.7);opacity:.55}100%{transform:scale(1.5);opacity:0}}
@keyframes jvOnda{0%,100%{opacity:.35;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion: reduce){
  .jv-pulsa::after,.jv-onda{animation:none}
}`;

const FIM_DE_FRASE = /(?<=[.!?\n])\s+/;

// Nomes masculinos de voz pt-BR mais comuns entre Windows, macOS e Chrome.
// A lista e por nome porque a Web Speech API nao expoe genero -- `voiceURI` e
// `name` sao tudo que da para inspecionar.
const MASCULINAS = /antonio|ant[oô]nio|daniel|felipe|ricardo|jo[aã]o|thiago|lu[ií]s|luiz|male|homem/i;

/**
 * Voz da resposta, em ordem de preferencia:
 *   1. pt-BR com nome masculino conhecido
 *   2. qualquer pt-BR
 *   3. pt-PT, so entao
 *
 * Roda tambem no `voiceschanged`: no Chrome a lista chega vazia no primeiro
 * render e so e populada depois, entao escolher uma unica vez daria silencio.
 */
function escolherVoz(): SpeechSynthesisVoice | null {
  const vozes = window.speechSynthesis?.getVoices?.() ?? [];
  if (!vozes.length) return null;
  const lang = (v: SpeechSynthesisVoice) => (v.lang ?? "").toLowerCase().replace("_", "-");

  const brasileiras = vozes.filter((v) => lang(v).startsWith("pt-br"));
  const masculina = brasileiras.find((v) => MASCULINAS.test(v.name ?? ""));
  if (masculina) return masculina;
  if (brasileiras.length) return brasileiras[0];

  const portuguesas = vozes.filter((v) => lang(v).startsWith("pt"));
  const masculinaPt = portuguesas.find((v) => MASCULINAS.test(v.name ?? ""));
  return masculinaPt ?? portuguesas[0] ?? null;
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
  const [analisando, setAnalisando] = useState(false);
  const [entradaTexto, setEntradaTexto] = useState("");

  const conversaRef = useRef<string | null>(null);
  const reconhecimentoRef = useRef<any>(null);
  const vozRef = useRef<SpeechSynthesisVoice | null>(null);
  const bufferFalaRef = useRef("");
  // Ref alem do state: o closure de `enviar` congelava o valor antigo de
  // `analisando` e a trava de duplicidade nao pegava.
  const analisandoRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  // Cada nova fala invalida qualquer sintese que ainda esteja baixando. Sem
  // isso, uma resposta antiga poderia terminar de baixar e falar por cima da
  // pergunta mais recente.
  const geracaoAudioRef = useRef(0);
  const responderEmVozRef = useRef(false);

  // Rollout: MGMT primeiro. O projeto nao tem feature flag, entao a trava e o
  // proprio RBAC. Nao e barreira de seguranca -- o servidor ja filtra as
  // ferramentas por papel -- e so para nao expor a Jarvis antes da validacao.
  // Quem decide e o Worker, em /api/jarvis/access: mesma origem do app, logo
  // sobrevive ao dominio temporario de preview. A consulta direta ao Supabase
  // que existia aqui era barrada por CORS no preview e derrubava o gate.
  //
  // CAUSA DO BUG SEGUINTE: isso era um `getSession()` unico no mount. Na carga
  // fria a sessao ainda esta sendo restaurada do storage, o token vem null, o
  // efeito desistia e nunca mais tentava -- nenhuma requisicao a /access
  // chegava a sair. Agora a sessao e' ESTADO, alimentado pelo mesmo par
  // getSession + onAuthStateChange que o resto do dashboard usa, e a checagem
  // roda de novo quando o token aparece.
  const [sessao, setSessao] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSessao(data.session)).catch(() => setSessao(null));
    // O `next` do evento ja traz a sessao. Chamar getSession() aqui dentro
    // reentra no mutex do supabase-js e trava -- ver nota em shared.tsx.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_evento, next) => setSessao(next));
    return () => subscription.unsubscribe();
  }, []);

  // A conversa e' servidor-owned; o navegador guarda somente o UUID para
  // retomar o mesmo historico apos refresh. A chave e' por usuario para nunca
  // herdar contexto de outra sessao no mesmo computador.
  useEffect(() => {
    const userId = sessao?.user?.id;
    if (!userId) { conversaRef.current = null; return; }
    conversaRef.current = window.localStorage.getItem(`jarvis:conversation:${userId}`);
  }, [sessao?.user?.id]);

  useEffect(() => {
    const jwt = sessao?.access_token;
    if (!jwt) { setLiberado(false); return; }
    let vivo = true;
    void (async () => {
      try {
        const r = await fetch("/api/jarvis/access", { headers: { authorization: `Bearer ${jwt}` } });
        if (!r.ok) { if (vivo) setLiberado(false); return; }
        const { allowed } = (await r.json()) as { allowed?: boolean };
        if (vivo) setLiberado(allowed === true);
      } catch {
        // Sem sessao ou rota indisponivel: fica oculta, sem erro na tela.
        if (vivo) setLiberado(false);
      }
    })();
    return () => { vivo = false; };
  }, [sessao?.access_token]);

  // Não aquece o Jarvis automaticamente ao montar o dashboard.
  // O prewarm é pesado e exclusivo de MGMT; dispará-lo no load podia concorrer
  // com a carga do home e deixar só o perfil do Adler preso em “Atualizando…”.
  // A memória continua sendo preenchida sob demanda quando o Jarvis é usado.

  // Temporario, so para confirmar montagem no preview. Sem pessoa, papel,
  // token ou qualquer dado de usuario -- apenas o booleano do gate.
  useEffect(() => {
    console.info({ event: "jarvis_mounted", allowed: liberado });
  }, [liberado]);

  useEffect(() => {
    const carregar = () => { vozRef.current = escolherVoz(); };
    carregar();
    window.speechSynthesis?.addEventListener?.("voiceschanged", carregar);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", carregar);
  }, []);

  const falar = useCallback((texto: string): boolean => {
    const limpo = texto.trim();
    if (!limpo || !window.speechSynthesis) return false;
    const fala = new SpeechSynthesisUtterance(limpo);
    fala.lang = "pt-BR";
    if (vozRef.current) fala.voice = vozRef.current;
    // Natural e firme: acima de 1.1 a fala atropela; pitch abaixo de 1 assenta
    // a voz sem soar artificial.
    fala.rate = 1;
    fala.pitch = 0.9;
    fala.onstart = () => setFalando(true);
    fala.onend = () => setFalando(window.speechSynthesis.speaking);
    fala.onerror = () => setFalando(window.speechSynthesis.speaking);
    window.speechSynthesis.speak(fala);
    return true;
  }, []);

  /** Silencia TUDO: sintese do navegador e audio do servidor. */
  const calar = useCallback(() => {
    geracaoAudioRef.current += 1;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setFalando(false);
    bufferFalaRef.current = "";
  }, []);

  /**
   * Fala a resposta inteira.
   *
   * Tenta a voz propria (`/api/jarvis/tts`, MP3 pelo Worker). So cai no
   * `speechSynthesis` se ela falhar -- e nunca os dois juntos, porque `calar()`
   * roda antes de qualquer um dos dois comecar.
   */
  const falarResposta = useCallback(async (texto: string) => {
    const limpo = texto.trim();
    if (!limpo) return;
    calar();
    const geracao = geracaoAudioRef.current;
    // A sintese no servidor tambem faz parte da resposta. Sem isto, a UI sai
    // de "Analisando" e fica muda enquanto o MP3 e produzido/baixado.
    setFalando(true);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("sem sessao");

      const r = await fetch("/api/jarvis/tts", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: limpo.slice(0, 1200) }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);

      const blob = await r.blob();
      if (!blob.size) throw new Error("audio vazio");
      if (geracaoAudioRef.current !== geracao) return;

      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      const encerrar = () => {
        setFalando(false);
        if (blobUrlRef.current === url) { URL.revokeObjectURL(url); blobUrlRef.current = null; }
      };
      audio.onplay = () => setFalando(true);
      audio.onended = encerrar;
      audio.onerror = encerrar;
      await audio.play();
      return;
    } catch {
      if (geracaoAudioRef.current !== geracao) return;
      // Sem voz propria, melhor a do navegador do que silencio. O motivo fica
      // no log do Worker; aqui nao vale poluir a tela com isso.
      if (!falar(limpo)) setFalando(false);
    }
  }, [calar, falar]);

  useEffect(() => () => calar(), [calar]);

  const enviar = useCallback(async (mensagem: string, viaVoz: boolean) => {
    const texto = mensagem.trim();
    if (!texto || analisandoRef.current) return;   // trava envio duplicado
    responderEmVozRef.current = viaVoz;
    setErro(null);
    setParcial("");
    analisandoRef.current = true;
    setAnalisando(true);
    // Resposta curta troca de estado em ~200ms e o "Analisando" pisca sem ser
    // visto. Segura um piso para o estado existir de fato para quem olha.
    const podeSair = Date.now() + 500;
    const encerrarAnalise = () => {
      const faltam = podeSair - Date.now();
      if (faltam > 0) setTimeout(() => { analisandoRef.current = false; setAnalisando(false); }, faltam);
      else { analisandoRef.current = false; setAnalisando(false); }
    };
    setLinhas((atual) => [...atual, { tipo: "usuario", texto }]);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { setErro("sessão expirada"); encerrarAnalise(); return; }

    let resposta: Response;
    try {
      resposta = await fetch("/api/jarvis/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversaRef.current, message: texto, voice: viaVoz }),
      });
    } catch {
      setErro("não consegui falar com o servidor");
      encerrarAnalise();
      return;
    }
    if (!resposta.ok || !resposta.body) { setErro(`falhou (${resposta.status})`); encerrarAnalise(); return; }

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
          // Ferramentas são implementação interna. A interface mostra só pergunta e resposta;
          // o uso de tools continua disponível nos logs/metadata para diagnóstico.
        } else if (evento === "token") {
          encerrarAnalise();
          setLinhas((a) => {
            const copia = [...a];
            for (let i = copia.length - 1; i >= 0; i--) {
              if (copia[i].tipo === "jarvis") { copia[i] = { tipo: "jarvis", texto: copia[i].texto + dados.text }; break; }
            }
            return copia;
          });
          // Acumula sem falar. Com voz propria, sintetizar frase a frase seria
          // uma chamada paga por frase e cortes audiveis entre elas.
          bufferFalaRef.current += dados.text;
        } else if (evento === "pending") {
          encerrarAnalise();
          setPendencia({ id: dados.action_id, resumo: dados.summary });
          if (responderEmVozRef.current) void falarResposta(`${dados.summary}. Confirmo?`);
        } else if (evento === "error") {
          encerrarAnalise();
          setErro(String(dados.message ?? "erro"));
        } else if (evento === "done") {
          const conversationId = String(dados.conversation_id ?? "").trim();
          if (conversationId) {
            conversaRef.current = conversationId;
            const userId = data.session?.user?.id;
            if (userId) window.localStorage.setItem(`jarvis:conversation:${userId}`, conversationId);
          }
        }
      }
    }
    const completa = bufferFalaRef.current.trim();
    bufferFalaRef.current = "";
    encerrarAnalise();
    if (completa && responderEmVozRef.current) void falarResposta(completa);
  }, [falar, falarResposta]);

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
    void falarResposta(dito);
  }, [pendencia, falarResposta]);

  const ouvir = useCallback(() => {
    calar(); // interrompe a fala assim que o mic liga
    const Reconhecimento = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Reconhecimento) { setErro("este navegador não reconhece voz; use o campo de texto"); return; }

    const r = new Reconhecimento();
    r.lang = "pt-BR";
    r.interimResults = true;
    r.continuous = false;
    r.onstart = () => setOuvindo(true);
    r.onspeechend = () => { try { r.stop(); } catch { /* ja parou */ } };
    r.onresult = (evento: any) => {
      let final = "", provisorio = "";
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        const t = evento.results[i][0].transcript;
        if (evento.results[i].isFinal) final += t; else provisorio += t;
      }
      setParcial(provisorio);
      if (final) { setOuvindo(false); r.stop(); void enviar(final, true); }
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

  // CAUSA DO BUG: este listener era registrado mesmo quando `liberado` era
  // false. Como o gate so barra o RENDER (o early return la embaixo), o atalho
  // continuava vivo: o microfone abria, a pergunta ia, a resposta voltava e a
  // Jarvis falava -- com a interface inteira devolvendo null. Voz funcionando e
  // zero estado na tela e exatamente esse cenario.
  useEffect(() => {
    if (!liberado) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Space") { e.preventDefault(); alternar(); }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [alternar, liberado]);

  const estado: Estado = ouvindo ? "ouvindo" : analisando ? "analisando" : falando ? "respondendo" : "inativo";

  if (!liberado) return null;

  /**
   * Camada de estado.
   *
   * Fica FORA do painel e acima de tudo (z-index 2147483000, o topo pratico).
   * Antes era uma linha de 12px dentro de um painel de 360px encostado no
   * canto -- existia, mas nao se via. Estado de voz precisa ser percebido sem
   * procurar, senao a pessoa fala por cima da Jarvis ou acha que travou.
   */
  const indicador = estado === "inativo" ? null : (
    <div style={overlay} role="status" aria-live="polite">
      <div style={{ ...cartaoEstado, borderColor: COR_ESTADO[estado] }}>
        <span
          className={estado === "ouvindo" ? "jv-orbe jv-pulsa" : "jv-orbe"}
          style={{ ...orbeGrande, background: COR_ESTADO[estado], color: COR_ESTADO[estado] }}
          aria-hidden="true"
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ ...rotuloEstado, color: COR_ESTADO[estado] }}>
            {estado === "respondendo" && <span className="jv-onda" aria-hidden="true" />}
            {ROTULO_ESTADO[estado]}
          </div>
          {estado === "ouvindo" && (
            <div style={transcricao}>{parcial || "pode falar"}</div>
          )}
        </div>
        {estado === "ouvindo" && (
          <button type="button" onClick={alternar} style={botaoCancelarEstado} aria-label="Cancelar a captação de voz">
            Cancelar
          </button>
        )}
      </div>
    </div>
  );

  if (!ativo && !linhas.length) {
    return (
      <>
        <style>{PULSO_CSS}</style>
        {indicador}
        <button
          type="button"
          onClick={alternar}
          title="Falar com a Jarvis (Ctrl+Espaço)"
          aria-label="Falar com a Jarvis"
          style={botaoFlutuante}
        >
          🎙 Jarvis
        </button>
      </>
    );
  }

  return (
    <>
      <style>{PULSO_CSS}</style>
      {indicador}
      <div style={painel}>

      <div style={cabecalho}>
        <span
          className={ouvindo ? "jv-orbe jv-pulsa" : "jv-orbe"}
          style={{ ...nucleo, background: COR_ESTADO[estado] }}
          aria-hidden="true"
        />
        <strong style={{ fontSize: 13 }}>Jarvis</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>Ctrl+Espaço</span>
        <button type="button" onClick={() => { calar(); setAtivo(false); }} style={fechar} aria-label="Fechar a Jarvis">×</button>
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const texto = entradaTexto.trim();
          if (!texto || analisando) return;
          setEntradaTexto("");
          void enviar(texto, false);
        }}
        style={formTexto}
      >
        <input
          value={entradaTexto}
          onChange={(e) => setEntradaTexto(e.target.value)}
          placeholder="Pergunte por texto…"
          aria-label="Perguntar à Jarvis por texto"
          disabled={analisando}
          style={inputTexto}
        />
        <button type="submit" disabled={analisando || !entradaTexto.trim()} style={botaoEnviarTexto}>Enviar</button>
      </form>

      <button
        type="button"
        onClick={alternar}
        disabled={analisando}
        aria-label={ouvindo ? "Parar de ouvir" : "Falar com a Jarvis"}
        style={{
          ...micNoPainel,
          ...(ouvindo ? micAtivo : null),
          ...(analisando ? { opacity: 0.5, cursor: "not-allowed" } : null),
        }}
      >
        {ouvindo ? "Cancelar" : analisando ? "Analisando…" : "🎙 Falar"}
        </button>
      </div>
    </>
  );
}

/* estilos inline: o componente e um enxerto no OpsQuestion, nao tem folha propria */

// Pilula com rotulo, nao mais um circulo de 46px so com o emoji: no preview o
// botao existia e passava por enfeite do widget de texto ao lado. O z-index
// acompanha a camada de estado (topo pratico) porque z-index 30 ficava por
// baixo de barras e paineis que o dashboard sobrepoe nesse canto.
const botaoFlutuante: React.CSSProperties = {
  position: "fixed", right: 22, bottom: 92, zIndex: 2147482000,
  display: "inline-flex", alignItems: "center", gap: 8,
  height: 46, padding: "0 18px", borderRadius: 23, cursor: "pointer",
  border: "1px solid var(--line)", background: "var(--panel)", color: "var(--text)",
  fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", boxShadow: "var(--shadow)",
};

const painel: React.CSSProperties = {
  position: "fixed", right: 22, bottom: 92, zIndex: 30,
  width: "min(360px, calc(100vw - 44px))", maxHeight: "min(60vh, 520px)",
  display: "flex", flexDirection: "column", gap: 10, padding: 14,
  borderRadius: 16, border: "1px solid var(--line)", background: "var(--panel)",
  color: "var(--text)", boxShadow: "var(--shadow)",
};

const cabecalho: React.CSSProperties = { display: "flex", alignItems: "center", gap: 9 };
const overlay: React.CSSProperties = {
  position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)",
  zIndex: 2147483000, pointerEvents: "none", maxWidth: "calc(100vw - 32px)",
};
const cartaoEstado: React.CSSProperties = {
  pointerEvents: "auto", display: "flex", alignItems: "center", gap: 13,
  padding: "13px 18px", borderRadius: 999,
  border: "1px solid", background: "rgba(6,16,28,.94)",
  backdropFilter: "blur(10px)", boxShadow: "0 18px 50px rgba(0,0,0,.45)",
};
const orbeGrande: React.CSSProperties = {
  width: 13, height: 13, borderRadius: "50%", display: "inline-block", flex: "none",
};
const rotuloEstado: React.CSSProperties = {
  display: "flex", alignItems: "center", fontSize: 14.5, fontWeight: 700,
  letterSpacing: ".01em", whiteSpace: "nowrap",
};
const transcricao: React.CSSProperties = {
  fontSize: 12.5, color: "var(--muted)", marginTop: 2,
  maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const botaoCancelarEstado: React.CSSProperties = {
  marginLeft: 4, padding: "6px 12px", borderRadius: 999, cursor: "pointer",
  border: "1px solid var(--line)", background: "transparent",
  color: "var(--text)", fontSize: 12.5,
};
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
const formTexto: React.CSSProperties = { display: "flex", gap: 7, alignItems: "center" };
const inputTexto: React.CSSProperties = {
  flex: 1, minWidth: 0, padding: "9px 10px", borderRadius: 10,
  border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--text)",
  outline: "none", fontSize: 13,
};
const botaoEnviarTexto: React.CSSProperties = {
  padding: "9px 11px", borderRadius: 10, border: "1px solid var(--line)",
  background: "var(--panel2)", color: "var(--text)", cursor: "pointer", fontWeight: 600,
};
const micNoPainel: React.CSSProperties = {
  padding: "9px 12px", borderRadius: 10, cursor: "pointer",
  border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--text)",
};
const micAtivo: React.CSSProperties = { borderColor: "var(--accent)", color: "var(--accent)" };
