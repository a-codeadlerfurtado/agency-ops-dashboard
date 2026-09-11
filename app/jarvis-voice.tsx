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

function corrigirTranscricaoJarvis(v: string): string {
  return String(v || "").replace(/\blitros\b/giu, "leads").replace(/\blitro\b/giu, "lead");
}

/**
 * `allowed` vem do router, que acabou de resolver o perfil via loadProfileLite.
 * Quando informado, evita a segunda cadeia /api/jarvis/access ->
 * identificarUsuario -> profile-lite, que ao estourar escondia o botao. E' gate
 * VISUAL; a seguranca real continua em cada rota /api/jarvis/*.
 */
export default function JarvisVoice({ allowed }: { allowed?: boolean } = {}) {
  const [ativo, setAtivo] = useState(false);
  const [ouvindo, setOuvindo] = useState(false);
  const [falando, setFalando] = useState(false);
  const [parcial, setParcial] = useState("");
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [pendencia, setPendencia] = useState<Pendencia | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [liberado, setLiberado] = useState(allowed === true);
  const [analisando, setAnalisando] = useState(false);
  const [entradaTexto, setEntradaTexto] = useState("");
  const [ttsProvider, setTtsProvider] = useState<"jarvis" | "cedar" | null>(null);

  const conversaRef = useRef<string | null>(null);
  const reconhecimentoRef = useRef<any>(null);
  const bufferFalaRef = useRef("");
  // Ref alem do state: o closure de `enviar` congelava o valor antigo de
  // `analisando` e a trava de duplicidade nao pegava.
  const analisandoRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const pcmSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  // Cada nova fala invalida qualquer sintese que ainda esteja baixando. Sem
  // isso, uma resposta antiga poderia terminar de baixar e falar por cima da
  // pergunta mais recente.
  const geracaoAudioRef = useRef(0);
  const responderEmVozRef = useRef(false);
  const warmIdleKeyRef = useRef<string | null>(null);

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
  const sessaoRef = useRef<Session | null>(null);
  useEffect(() => { sessaoRef.current = sessao; }, [sessao]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSessao(data.session)).catch(() => setSessao(null));
    // O `next` do evento ja traz a sessao. Chamar getSession() aqui dentro
    // reentra no mutex do supabase-js e trava -- ver nota em shared.tsx.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_evento, next) => setSessao(next));
    return () => subscription.unsubscribe();
  }, []);

  // Aquece o contexto leve em idle, sem disputar com a carga inicial do dashboard.
  // Assim a primeira pergunta ja encontra identidade/carteira/catalogo quentes.
  useEffect(() => {
    const token = sessao?.access_token; const userId = sessao?.user?.id;
    if (!liberado || !token || !userId || warmIdleKeyRef.current === userId) return;
    warmIdleKeyRef.current = userId;
    const run = () => { void fetch("/api/jarvis/warm-lite", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => null); };
    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: any) => number);
    const cic = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
    if (ric) { const id = ric(run, { timeout: 800 }); return () => { try { cic?.(id); } catch {} }; }
    const id = window.setTimeout(run, 300); return () => window.clearTimeout(id);
  }, [liberado, sessao?.access_token, sessao?.user?.id]);

  // A conversa e' servidor-owned; o navegador guarda somente o UUID para
  // retomar o mesmo historico apos refresh. A chave e' por usuario para nunca
  // herdar contexto de outra sessao no mesmo computador.
  useEffect(() => {
    const userId = sessao?.user?.id;
    if (!userId) { conversaRef.current = null; return; }
    conversaRef.current = window.localStorage.getItem(`jarvis:conversation:${userId}`);
  }, [sessao?.user?.id]);

  useEffect(() => {
    // Perfil ja resolvido pelo router: nao repete a consulta.
    if (allowed !== undefined) { setLiberado(allowed === true); return; }
    const jwt = sessao?.access_token;
    if (!jwt) { setLiberado(false); return; }
    let vivo = true;
    void (async () => {
      try {
        const r = await fetch("/api/jarvis/access", { headers: { authorization: `Bearer ${jwt}` } });
        if (!r.ok) { if (vivo) setLiberado(false); return; }
        const corpo = (await r.json()) as { allowed?: boolean };
        if (vivo) setLiberado(corpo.allowed === true);
      } catch {
        // Sem sessao ou rota indisponivel: fica oculta, sem erro na tela.
        if (vivo) setLiberado(false);
      }
    })();
    return () => { vivo = false; };
  }, [allowed, sessao?.access_token]);

  // Não aquece o Jarvis automaticamente ao montar o dashboard.
  // O prewarm é pesado e exclusivo de MGMT; dispará-lo no load podia concorrer
  // com a carga do home e deixar só o perfil do Adler preso em “Atualizando…”.
  // A memória continua sendo preenchida sob demanda quando o Jarvis é usado.

  // Temporario, so para confirmar montagem no preview. Sem pessoa, papel,
  // token ou qualquer dado de usuario -- apenas o booleano do gate.
  useEffect(() => {
    console.info({ event: "jarvis_mounted", allowed: liberado });
  }, [liberado]);

  // HARD LOCK: este dashboard nao pode falar por Web Speech. Mesmo que algum
  // bundle antigo/terceiro tente usar speechSynthesis, o metodo e neutralizado
  // enquanto o Jarvis estiver montado. A unica fala permitida e o MP3 Cedar.
  useEffect(() => {
    const synth = window.speechSynthesis as any;
    if (!synth) return;
    try { synth.cancel?.(); } catch {}
    const originalSpeak = synth.speak;
    try {
      synth.speak = (..._args: any[]) => {
        console.error({ event: "jarvis_browser_tts_blocked" });
        try { synth.cancel?.(); } catch {}
      };
    } catch {}
    return () => {
      try { synth.cancel?.(); } catch {}
      try { synth.speak = originalSpeak; } catch {}
    };
  }, []);

  /** Interrompe exclusivamente o audio Cedar do servidor. */
  const calar = useCallback(() => {
    geracaoAudioRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    for (const source of pcmSourcesRef.current) {
      try { source.stop(); } catch {}
    }
    pcmSourcesRef.current.clear();
    setFalando(false);
    bufferFalaRef.current = "";
  }, []);

  /**
   * Fala a resposta inteira usando exclusivamente Cedar via /api/jarvis/tts.
   * Nao existe SpeechSynthesis/Web Speech como fallback neste componente.
   */
  const falarResposta = useCallback(async (texto: string) => {
    const ttsInicio = performance.now();
    const limpo = texto.trim();
    if (!limpo) return;
    calar();
    const geracao = geracaoAudioRef.current;
    setFalando(true);

    try {
      const token = sessaoRef.current?.access_token;
      if (!token) throw new Error("sem sessao");

      const r = await fetch("/api/jarvis/tts", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: limpo.slice(0, 1200) }),
      });
      console.info({ event: "jarvis_latency", stage: "tts_headers", ms: Math.round(performance.now() - ttsInicio) });
      if (!r.ok) {
        const detalhe = await r.json().catch(() => null) as { erro?: string } | null;
        throw new Error(detalhe?.erro || `tts ${r.status}`);
      }
      const engine = (r.headers.get("x-jarvis-tts-engine") || "").toLowerCase();
      const voice = (r.headers.get("x-jarvis-tts-voice") || "").toLowerCase();
      const ttsBuild = (r.headers.get("x-jarvis-tts-build") || "").toLowerCase();
      const formato = (r.headers.get("x-jarvis-tts-format") || "").toLowerCase();
      const localOk = engine === "local" && voice === "pm_jarvis" && ttsBuild === "hybrid-local-first-v1";
      const cedarOk = engine === "openai" && voice === "cedar" && ttsBuild === "hybrid-local-first-v1";
      if (!localOk && !cedarOk) {
        throw new Error(`tts_provider_invalido:${engine || "sem-engine"}:${voice || "sem-voice"}:${ttsBuild || "sem-build"}`);
      }

      // Caminho de menor latencia: PCM bruto 24 kHz. Cada chunk vira um AudioBuffer
      // e e agendado imediatamente; nao espera o arquivo inteiro existir.
      if (formato === "pcm_s16le_24000" && r.body) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) throw new Error("audio_context_indisponivel");
        let ctx = audioContextRef.current;
        if (!ctx || ctx.state === "closed") {
          ctx = new AudioCtx({ latencyHint: "interactive", sampleRate: 24000 });
          audioContextRef.current = ctx;
        }
        if (ctx.state === "suspended") await ctx.resume();

        const reader = r.body.getReader();
        let carry: number | null = null;
        let totalBytes = 0;
        let iniciou = false;
        let proximoInicio = ctx.currentTime + 0.08;
        let fimAgendado = proximoInicio;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (geracaoAudioRef.current !== geracao) { await reader.cancel().catch(() => {}); return; }
          if (!value?.byteLength) continue;
          totalBytes += value.byteLength;

          let bytes = value;
          if (carry !== null) {
            const juntado = new Uint8Array(value.byteLength + 1);
            juntado[0] = carry;
            juntado.set(value, 1);
            bytes = juntado;
            carry = null;
          }
          if (bytes.byteLength % 2) {
            carry = bytes[bytes.byteLength - 1];
            bytes = bytes.subarray(0, bytes.byteLength - 1);
          }
          const amostras = bytes.byteLength / 2;
          if (!amostras) continue;

          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const buffer = ctx.createBuffer(1, amostras, 24000);
          const canal = buffer.getChannelData(0);
          for (let i = 0; i < amostras; i++) canal[i] = view.getInt16(i * 2, true) / 32768;

          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          pcmSourcesRef.current.add(source);
          source.onended = () => pcmSourcesRef.current.delete(source);
          const inicio = Math.max(proximoInicio, ctx.currentTime + (iniciou ? 0.02 : 0.08));
          source.start(inicio);
          proximoInicio = inicio + buffer.duration;
          fimAgendado = proximoInicio;

          if (!iniciou) {
            iniciou = true;
            setTtsProvider(engine === "local" ? "jarvis" : "cedar");
            const espera = Math.max(0, (inicio - ctx.currentTime) * 1000);
            window.setTimeout(() => {
              if (geracaoAudioRef.current === geracao) {
                console.info({ event: "jarvis_latency", stage: "audio_play", ms: Math.round(performance.now() - ttsInicio), format: "pcm" });
                console.info({ event: "jarvis_cedar_play", engine, voice, streaming: true });
              }
            }, espera);
          }
        }

        if (!iniciou) throw new Error("audio vazio");
        console.info({ event: "jarvis_latency", stage: "tts_stream_end", ms: Math.round(performance.now() - ttsInicio), bytes: totalBytes });
        const restante = Math.max(0, (fimAgendado - ctx.currentTime) * 1000);
        window.setTimeout(() => {
          if (geracaoAudioRef.current === geracao) setFalando(false);
        }, restante + 60);
        return;
      }

      // Compatibilidade de rollback: ainda toca MP3 Cedar de uma versao anterior,
      // mas nunca usa Web Speech nem outra voz.
      const audioBytes = await r.arrayBuffer();
      console.info({ event: "jarvis_latency", stage: "tts_bytes", ms: Math.round(performance.now() - ttsInicio), bytes: audioBytes.byteLength });
      if (!audioBytes.byteLength) throw new Error("audio vazio");
      const blob = new Blob([audioBytes], { type: "audio/mpeg" });
      if (geracaoAudioRef.current !== geracao) return;
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      const encerrar = () => {
        setFalando(false);
        if (blobUrlRef.current === url) { URL.revokeObjectURL(url); blobUrlRef.current = null; }
      };
      audio.onplay = () => {
        console.info({ event: "jarvis_latency", stage: "audio_play", ms: Math.round(performance.now() - ttsInicio), format: "mp3" });
        setFalando(true);
        setTtsProvider(engine === "local" ? "jarvis" : "cedar");
        console.info({ event: "jarvis_cedar_play", engine, voice, bytes: audioBytes.byteLength });
      };
      audio.onended = encerrar;
      audio.onerror = () => {
        encerrar();
        if (geracaoAudioRef.current === geracao) setErro("Voz indisponível (falha de reprodução)");
      };
      await audio.play();
    } catch (erroTts) {
      if (geracaoAudioRef.current !== geracao) return;
      setFalando(false);
      const motivo = erroTts instanceof Error ? erroTts.message : String(erroTts);
      setErro(`Voz indisponível (${motivo})`);
    }
  }, [calar]);

  useEffect(() => () => {
    calar();
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }, [calar]);

  /**
   * Fecha a janela sem perder a conversa.
   *
   * O X antes fazia `setAtivo(false)`, mas o render decidia por
   * `!ativo && !linhas.length` -- com historico na tela a condicao nunca era
   * verdadeira e o painel continuava aberto. Agora a visibilidade depende so de
   * `ativo`; `linhas` e o conversation_id permanecem em memoria para quando o
   * usuario reabrir.
   */
  const fecharJarvis = useCallback(() => {
    calar();
    try { reconhecimentoRef.current?.stop?.(); } catch { /* ja parado */ }
    setOuvindo(false);
    setParcial("");
    setAtivo(false);
  }, [calar]);

  const enviar = useCallback(async (mensagem: string, viaVoz: boolean) => {
    const turnoInicio = performance.now();
    const texto = mensagem.trim();
    if (!texto || analisandoRef.current) return;   // trava envio duplicado
    // Preserve a origem deste turno dentro da propria closure. Usar apenas o
    // ref mutavel permitia que outro evento de UI alterasse a decisao antes do
    // fim do stream e deixasse uma pergunta por voz sem Cedar.
    const responderEmVoz = viaVoz;
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

    const session = sessaoRef.current;
    const token = session?.access_token;
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
    console.info({ event: "jarvis_latency", stage: "chat_headers", ms: Math.round(performance.now() - turnoInicio) });
    if (!resposta.ok || !resposta.body) { setErro(`falhou (${resposta.status})`); encerrarAnalise(); return; }

    setLinhas((atual) => [...atual, { tipo: "jarvis", texto: "" }]);
    const leitor = resposta.body.getReader();
    const decodificador = new TextDecoder();
    let sobra = "";
    let primeiroToken = false;
    let falaAntecipada = false;

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
          if (!primeiroToken) {
            primeiroToken = true;
            console.info({ event: "jarvis_latency", stage: "first_token", ms: Math.round(performance.now() - turnoInicio) });
          }
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
        } else if (evento === "speech_ready") {
          const fala = String(dados.text ?? "").trim();
          if (fala && !falaAntecipada) { falaAntecipada = true; void falarResposta(fala); }
        } else if (evento === "pending") {
          encerrarAnalise();
          setPendencia({ id: dados.action_id, resumo: dados.summary });
          falaAntecipada = true;
          void falarResposta(`${dados.summary}. Confirmo?`);
        } else if (evento === "error") {
          encerrarAnalise();
          setErro(String(dados.message ?? "erro"));
        } else if (evento === "done") {
          const conversationId = String(dados.conversation_id ?? "").trim();
          if (conversationId) {
            conversaRef.current = conversationId;
            const userId = session?.user?.id;
            if (userId) window.localStorage.setItem(`jarvis:conversation:${userId}`, conversationId);
          }
        }
      }
    }
    console.info({ event: "jarvis_latency", stage: "chat_stream_end", ms: Math.round(performance.now() - turnoInicio) });
    const completa = bufferFalaRef.current.trim();
    bufferFalaRef.current = "";
    encerrarAnalise();
    // Jarvis e um assistente de voz: toda resposta textual concluida sai em Cedar.
    // Nao existe mais caminho silencioso depois de uma resposta valida.
    if (completa && !falaAntecipada) void falarResposta(completa);
  }, [falarResposta]);

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

  const ouvirViaRecorder = useCallback(async () => {
    const token = sessaoRef.current?.access_token;
    if (!token) { setErro("sessão expirada"); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErro("microfone não suportado neste navegador"); return;
    }

    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let captureCtx: AudioContext | null = null;
    let timer = 0;
    let cancelled = false;
    const chunks: Blob[] = [];

    const cleanup = () => {
      if (timer) window.clearInterval(timer);
      try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
      try { if (captureCtx && captureCtx.state !== "closed") void captureCtx.close(); } catch {}
      reconhecimentoRef.current = null;
    };
    try {
      setErro(null);
      setParcial("ouvindo…");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
        .find((tipo) => MediaRecorder.isTypeSupported?.(tipo));
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const startedAt = Date.now();
      let speechStarted = false;
      let lastVoiceAt = startedAt;
      const stop = (cancel = false) => {
        cancelled = cancelled || cancel;
        if (recorder && recorder.state !== "inactive") recorder.stop();
      };
      reconhecimentoRef.current = { stop: () => stop(false), abort: () => stop(true) };
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = () => { setErro("erro ao gravar o microfone"); stop(true); };
      recorder.onstop = async () => {
        cleanup();
        setOuvindo(false);
        setParcial("");
        if (cancelled || !chunks.length) return;
        try {
          const blob = new Blob(chunks, { type: recorder?.mimeType || mime || "audio/webm" });
          const response = await fetch("/api/jarvis/stt", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": blob.type || "application/octet-stream" },
            body: blob,
          });
          const body = await response.json().catch(() => null) as { ok?: boolean; text?: string; error?: string } | null;
          const texto = corrigirTranscricaoJarvis(String(body?.text || "")).trim();
          if (!response.ok || !body?.ok || !texto) throw new Error(body?.error || "não entendi o áudio");
          void enviar(texto, true);
        } catch (erroStt) {
          setErro(erroStt instanceof Error ? erroStt.message : "não consegui transcrever");
        }
      };

      recorder.start(200);
      setOuvindo(true);
      const CaptureCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (CaptureCtx) {
        captureCtx = new CaptureCtx();
        const source = captureCtx.createMediaStreamSource(stream);
        const analyser = captureCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        timer = window.setInterval(() => {
          if (!recorder || recorder.state === "inactive") return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) { const n = (value - 128) / 128; sum += n * n; }
          const rms = Math.sqrt(sum / samples.length);
          const now = Date.now();
          if (rms > 0.025) { speechStarted = true; lastVoiceAt = now; }
          if (speechStarted && now - lastVoiceAt > 950 && now - startedAt > 900) stop(false);
          else if (now - startedAt > 12000) stop(false);
        }, 100);
      } else {
        timer = window.setInterval(() => { if (Date.now() - startedAt > 10000) stop(false); }, 250);
      }
    } catch (erroMic) {
      cleanup();
      setOuvindo(false);
      setParcial("");
      const nome = erroMic instanceof DOMException ? erroMic.name : "";
      setErro(nome === "NotAllowedError" ? "permita o acesso ao microfone para falar com a Jarvis" : "não consegui acessar o microfone");
    }
  }, [enviar]);

  const ouvir = useCallback(() => {
    calar();
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx && (!audioContextRef.current || audioContextRef.current.state === "closed")) {
        audioContextRef.current = new AudioCtx({ latencyHint: "interactive", sampleRate: 24000 });
      }
      if (audioContextRef.current?.state === "suspended") void audioContextRef.current.resume().catch(() => {});
    } catch {}
    const tokenWarm = sessaoRef.current?.access_token;
    if (tokenWarm) void fetch("/api/jarvis/warm-lite", { method: "POST", headers: { authorization: `Bearer ${tokenWarm}` } }).catch(() => null);

    const Reconhecimento = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || Boolean(window.matchMedia?.("(pointer: coarse)").matches);
    if (mobile || !Reconhecimento) { void ouvirViaRecorder(); return; }

    const r = new Reconhecimento();
    r.lang = "pt-BR"; r.interimResults = true; r.continuous = false;
    r.onstart = () => setOuvindo(true);
    r.onspeechend = () => { try { r.stop(); } catch {} };
    r.onresult = (evento: any) => {
      let final = "", provisorio = "";
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        const t = evento.results[i][0].transcript;
        if (evento.results[i].isFinal) final += t; else provisorio += t;
      }
      const parcialCorrigido = corrigirTranscricaoJarvis(provisorio);
      const finalCorrigido = corrigirTranscricaoJarvis(final);
      setParcial(parcialCorrigido);
      if (finalCorrigido) { setOuvindo(false); r.stop(); void enviar(finalCorrigido, true); }
    };
    r.onerror = () => { setOuvindo(false); setErro("não consegui ouvir"); };
    r.onend = () => setOuvindo(false);
    reconhecimentoRef.current = r;
    setOuvindo(true);
    r.start();
  }, [calar, enviar, ouvirViaRecorder]);

  const alternar = useCallback(() => {
    if (ouvindo) { reconhecimentoRef.current?.abort?.(); reconhecimentoRef.current?.stop?.(); setOuvindo(false); setParcial(""); return; }
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

  if (!ativo) {
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
        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, opacity: ttsProvider ? 1 : 0.7, color: ttsProvider ? "var(--green)" : "var(--muted)" }}>
          {ttsProvider === "jarvis" ? "Jarvis local ✓" : ttsProvider === "cedar" ? "Cedar fallback" : "Jarvis local"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>Ctrl+Espaço</span>
        <button type="button" onClick={fecharJarvis} style={fechar} aria-label="Fechar a Jarvis">×</button>
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
