"use client";

import { useEffect } from "react";
import {
  MOTION_EVENT,
  readAnimationsEnabled,
  readMotionBackground,
  type MotionBackground,
} from "./motion-live-preferences";

/*
 * Motion Live: movimento e fundo animado por cima do que ja existe, em todas as
 * paginas (o componente mora no layout raiz). Regras que nao podem quebrar:
 *
 *  - Nada aqui muda cor, layout ou conteudo. O fundo usa as mesmas tres cores que
 *    o body ja usa em contrast-tune.css (azul claro, laranja e azul da marca).
 *  - Os numeros sao do React. A contagem altera o MESMO no de texto (nodeValue),
 *    nunca troca o no, e devolve o texto original no fim. Se o React escrever um
 *    valor novo no meio da contagem, a contagem para e o valor do React fica.
 *  - Aba em segundo plano nao recebe requestAnimationFrame. Por isso a contagem
 *    tem um timer de seguranca: sem ele o numero ficaria parado no meio.
 *  - "Animacoes" desligado no perfil, ou prefers-reduced-motion, desliga tudo.
 */

const EASE = "cubic-bezier(.16, 1, .3, 1)";
const SPRING = "cubic-bezier(.34, 1.56, .64, 1)";

const VALUE_SELECTOR = ".metric .value, .rail-legend b";
const BADGE_SELECTOR = ".icon-btn b, .counter";

// Cards que motion-system.tsx ja revela na carga. Aqui eles so ganham a entrada
// quando aparecem pela primeira vez ao rolar a pagina.
const KNOWN_REVEAL = ".card, .action-card, .metric, .health-item, .ops-cockpit-lane, .ops-incident";

// Cards das outras abas, que motion-system.tsx nao conhece.
// Componentes identificados nas diferentes rotas do Dashboard. A lista e
// intencionalmente explicita: evita animar botoes e formularios por engano.
const EXTRA_REVEAL = [
  // Campanhas, criacao, leads e relatorios
  ".tc-section", ".tc-metric", ".tc-tab-body", ".cb-card", ".cb-plan-section",
  ".cb-guide-section", ".lc-kpi", ".mr-card", ".wr-client",
  // Operacao, financeiro, onboarding e atendimento
  ".cb-panel", ".cb-banner", ".finance-panel", ".fr-card",
  ".lo-card", ".lo-meeting-row", ".lw-list", ".ob-card",
  ".ob-assignment-card", ".ob-sla-section", ".of-card", ".op-card",
  ".oo-client", ".oh-card", ".oh-section", ".nh-kpis", ".nh-list",
  ".learning-card", ".dn-card", ".voc-card", ".funnel-card",
  // Comercial, Meta, inteligencia e ferramentas
  ".cp-card", ".cp-report-card", ".cp-week-card", ".ma-metric",
  ".ma-window-summary", ".mp-card", ".mp-focus-summary",
  ".rv2-panel", ".rv2-kpi", ".rv2-risk-panel", ".rv2-creative-card",
  ".aih-metric", ".aih-section", ".ai-context-card",
  // Outros componentes que ja recebem movimento no Dashboard
  ".aiw-card", ".mc-creative-card", ".aii-budget-card",
  ".person-card", ".evidence-card", ".detail-card", ".system-update-card",
  ".cp-kpi", ".cd-kpi", ".cfc-kpi", ".cc-kpi", ".cc-stat", ".c360-metric",
].join(",");

// Garante uma entrada sutil mesmo nas abas que usam componentes proprios sem
// nenhum dos seletores acima. Novos paineis sao observados na navegacao SPA.
const PAGE_REVEAL = "main, [role='main'], [role='tabpanel']";

const RISE: Keyframe[] = [
  { opacity: 0, transform: "translate3d(0, 22px, 0) scale(.975)", filter: "blur(5px)" },
  { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)", filter: "blur(0px)" },
];

// "R$ 1.457", "27", "1,7%", "68": prefixo, inteiro com milhar, decimais, sufixo.
// Texto com mais de um numero (datas, intervalos) nao casa e fica como esta.
const NUMBER_RE = /^(\D*?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(\D*)$/;

// r, g, b, alfa base, x, y, raio, velocidade, fase. Mesmas cores do fundo atual.
const BLOBS: number[][] = [
  [118, 198, 255, 0.1, 0.14, 0.12, 0.38, 0.11, 0],
  [255, 122, 47, 0.09, 0.88, 0.08, 0.32, 0.09, 2],
  [3, 89, 166, 0.2, 0.55, 0.8, 0.46, 0.13, 4],
  [118, 198, 255, 0.06, 0.86, 0.82, 0.32, 0.1, 1],
  [255, 122, 47, 0.05, 0.3, 0.9, 0.3, 0.08, 3],
  [3, 89, 166, 0.14, 0.4, 0.35, 0.4, 0.07, 5],
];
const GAIN: Record<MotionBackground, number> = { off: 0, leve: 0.55, medio: 1.25, forte: 2.1 };
const PULSES: Record<MotionBackground, number> = { off: 0, leve: 8, medio: 18, forte: 30 };
const GRID = 44;

type Pulse = { horizontal: boolean; line: number; dir: number; len: number; speed: number; pos: number; color: string };
type Counting = HTMLElement & { __mlBusy?: boolean; __mlLast?: number };

function spawnPulse(pulse: Pulse): Pulse {
  const width = window.innerWidth;
  const height = window.innerHeight;
  pulse.horizontal = Math.random() < 0.5;
  pulse.line = Math.round(Math.random() * ((pulse.horizontal ? height : width) / GRID)) * GRID;
  pulse.dir = Math.random() < 0.5 ? 1 : -1;
  pulse.len = 90 + Math.random() * 110;
  pulse.speed = 110 + Math.random() * 190;
  pulse.pos = pulse.dir > 0 ? -pulse.len : (pulse.horizontal ? width : height) + pulse.len;
  pulse.color = Math.random() < 0.3 ? "255,122,47" : "118,198,255";
  return pulse;
}

function alphaOf(color: string) {
  if (!color || color === "transparent") return 0;
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return 1;
  const parts = match[1].split(/[,/ ]+/).filter(Boolean);
  return parts.length >= 4 ? Number.parseFloat(parts[3]) || 0 : 1;
}

// Existe um bloco do tamanho da tela com fundo proprio entre o body e o conteudo?
// Modais e avisos (position: fixed) nao contam: eles vem e vao.
function pageIsOpaque(ignore: Element[]) {
  const minWidth = window.innerWidth * 0.85;
  const minHeight = window.innerHeight * 0.85;
  const queue: { el: Element; depth: number }[] = Array.from(document.body.children).map((el) => ({ el, depth: 0 }));
  while (queue.length) {
    const { el, depth } = queue.shift() as { el: Element; depth: number };
    if (!(el instanceof HTMLElement) || ignore.includes(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < minWidth || rect.height < minHeight) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;
    if (alphaOf(style.backgroundColor) > 0.5 || style.backgroundImage !== "none") return true;
    if (depth < 3) Array.from(el.children).forEach((child) => queue.push({ el: child, depth: depth + 1 }));
  }
  return false;
}

export default function MotionLive() {
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const background = document.createElement("canvas");
    background.className = "motion-live-bg";
    const effects = document.createElement("canvas");
    effects.className = "motion-live-fx";
    const grid = document.createElement("div");
    grid.className = "motion-live-grid";
    [background, effects, grid].forEach((el) => el.setAttribute("aria-hidden", "true"));
    document.body.append(background, effects, grid);
    const layers: Element[] = [background, effects, grid];
    const bg = background.getContext("2d");
    const fx = effects.getContext("2d");

    let level: MotionBackground = "off";
    let motionOn = false;
    let overlay = false;
    let frame = 0;
    let lastTick = 0;
    let lastAurora = 0;
    let lastMove = 0;
    let pulses: Pulse[] = [];
    let tilted: HTMLElement | null = null;

    const backgroundActive = () => level !== "off" && root.dataset.theme !== "light" && !document.hidden;

    function draw(ms: number) {
      frame = 0;
      if (!backgroundActive() || !bg || !fx) return;
      const dt = Math.min(0.05, (ms - lastTick) / 1000);
      lastTick = ms;
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;

      // Luzes: canvas em 1/4 da resolucao (o navegador amplia e suaviza), 30 fps.
      if (ms - lastAurora >= 33) {
        lastAurora = ms;
        const w = Math.ceil(viewWidth / 4);
        const h = Math.ceil(viewHeight / 4);
        if (background.width !== w || background.height !== h) {
          background.width = w;
          background.height = h;
        }
        const t = ms / 1000;
      // Sobre fundos proprios a luz fica suave, mas cada intensidade continua
      // diferente (inclusive Forte), sem depender da transparencia da pagina.
      const gain = overlay ? GAIN[level] * 0.4 : GAIN[level];
        bg.clearRect(0, 0, w, h);
        bg.globalCompositeOperation = "lighter";
        for (const b of BLOBS) {
          const x = (b[4] + Math.sin(t * b[7] + b[8]) * 0.15) * w;
          const y = (b[5] + Math.cos(t * b[7] * 1.3 + b[8]) * 0.16) * h;
          const radius = b[6] * Math.max(w, h);
          const gradient = bg.createRadialGradient(x, y, 0, x, y, radius);
          gradient.addColorStop(0, `rgba(${b[0]},${b[1]},${b[2]},${Math.min(0.6, b[3] * gain)})`);
          gradient.addColorStop(1, `rgba(${b[0]},${b[1]},${b[2]},0)`);
          bg.fillStyle = gradient;
          bg.fillRect(0, 0, w, h);
        }
      }

      // Pulsos de luz pelas linhas da malha: discretos tambem sobre telas
      // opacas, com quantidade e intensidade reduzidas.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const fxWidth = Math.round(viewWidth * ratio);
      const fxHeight = Math.round(viewHeight * ratio);
      if (effects.width !== fxWidth || effects.height !== fxHeight) {
        effects.width = fxWidth;
        effects.height = fxHeight;
      }
      fx.setTransform(ratio, 0, 0, ratio, 0, 0);
      fx.clearRect(0, 0, viewWidth, viewHeight);
      {
        // Em telas opacas, os pulsos continuam presentes, porem em menor
        // quantidade e opacidade para nao disputar atencao com o conteudo.
        const wanted = overlay ? Math.ceil(PULSES[level] / 3) : PULSES[level];
        while (pulses.length < wanted) pulses.push(spawnPulse({} as Pulse));
        pulses.length = wanted;
        fx.globalAlpha = overlay ? 0.26 : 1;
        fx.lineWidth = 1;
        for (const pulse of pulses) {
          pulse.pos += pulse.dir * pulse.speed * dt;
          const limit = pulse.horizontal ? viewWidth : viewHeight;
          if (pulse.pos < -pulse.len * 2 || pulse.pos > limit + pulse.len * 2) {
            spawnPulse(pulse);
            continue;
          }
          const head = pulse.pos;
          const tail = pulse.pos - pulse.dir * pulse.len;
          const x1 = pulse.horizontal ? head : pulse.line + 0.5;
          const y1 = pulse.horizontal ? pulse.line + 0.5 : head;
          const x2 = pulse.horizontal ? tail : pulse.line + 0.5;
          const y2 = pulse.horizontal ? pulse.line + 0.5 : tail;
          const stroke = fx.createLinearGradient(x1, y1, x2, y2);
          stroke.addColorStop(0, `rgba(${pulse.color},.85)`);
          stroke.addColorStop(1, `rgba(${pulse.color},0)`);
          fx.strokeStyle = stroke;
          fx.shadowColor = `rgba(${pulse.color},.9)`;
          fx.shadowBlur = 6;
          fx.beginPath();
          fx.moveTo(x1, y1);
          fx.lineTo(x2, y2);
          fx.stroke();
          fx.fillStyle = `rgba(${pulse.color},.95)`;
          fx.beginPath();
          fx.arc(x1, y1, 1.4, 0, Math.PI * 2);
          fx.fill();
        }
        fx.globalAlpha = 1;
      }

      frame = window.requestAnimationFrame(draw);
    }

    const startLoop = () => {
      if (!frame && backgroundActive()) frame = window.requestAnimationFrame(draw);
    };

    const checkOverlay = () => {
      if (level === "off") return;
      const next = pageIsOpaque(layers);
      if (next === overlay) return;
      overlay = next;
      layers.forEach((el) => el.classList.toggle("is-overlay", overlay));
    };

    const applyPreferences = () => {
      const enabled = readAnimationsEnabled();
      motionOn = enabled && !reduce;
      level = motionOn ? readMotionBackground() : "off";
      root.dataset.animations = enabled ? "on" : "off";
      root.dataset.motionLive = motionOn ? "on" : "off";
      root.dataset.motionBg = level;
      checkOverlay();
      startLoop();
    };

    function countUp(element: Element, fromZero = false) {
      const el = element as Counting;
      if (!motionOn || el.__mlBusy) return;
      const node = Array.from(el.childNodes).find((child) => child.nodeType === 3 && (child.nodeValue || "").trim());
      if (!node) return;
      const original = node.nodeValue || "";
      const match = original.trim().match(NUMBER_RE);
      if (!match) return;
      const decimals = match[3] ? match[3].length : 0;
      const target = Number.parseFloat(match[2].replace(/\./g, "") + (decimals ? `.${match[3]}` : ""));
      const from = fromZero || el.__mlLast == null ? 0 : el.__mlLast;
      el.__mlLast = target;
      if (target === from) return;

      el.__mlBusy = true;
      const started = performance.now();
      let written = original;
      const finish = () => {
        if (node.isConnected && node.nodeValue === written) node.nodeValue = original;
        el.__mlBusy = false;
      };
      const safety = window.setTimeout(finish, 1700);
      const step = (now: number) => {
        if (!el.__mlBusy) return;
        // O React (ou outro script) escreveu por cima: o valor dele vence.
        if (node.nodeValue !== written || !node.isConnected) {
          window.clearTimeout(safety);
          el.__mlBusy = false;
          return;
        }
        const progress = Math.min(1, (now - started) / 1200);
        if (progress >= 1) {
          window.clearTimeout(safety);
          finish();
          return;
        }
        const eased = 1 - Math.pow(1 - progress, 4);
        written = match[1] + (from + (target - from) * eased).toLocaleString("pt-BR", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }) + match[4];
        node.nodeValue = written;
        window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    }

    const pending = new WeakSet<Element>();
    const revealed = new WeakSet<Element>();
    const rootsRevealed = new WeakSet<Element>();
    const reveal = (el: Element, delay = 0) => {
      if (revealed.has(el) || !(el instanceof HTMLElement)) return;
      revealed.add(el);
      if (!motionOn) return;
      el.animate(RISE, { duration: 620, delay, easing: EASE, fill: "backwards" });
      el.querySelectorAll(VALUE_SELECTOR).forEach((value) => countUp(value, true));
    };
    const onScreen = new IntersectionObserver(
      (entries) => {
        let index = 0;
        entries.forEach((entry) => {
          if (!entry.isIntersecting || !pending.has(entry.target)) return;
          pending.delete(entry.target);
          onScreen.unobserve(entry.target);
          reveal(entry.target, Math.min(index++ * 40, 320));
        });
      },
      { threshold: 0.08 },
    );
    const inViewport = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    };
    const matchesIn = (scope: Element, selector: string) => {
      const found = Array.from(scope.querySelectorAll(selector));
      if (scope.matches(selector)) found.unshift(scope);
      return found;
    };
    const register = (scope: Element) => {
      let index = 0;
      // Entrada leve da superficie principal em qualquer rota ou tab interna,
      // mesmo se o modulo nao usar classes de card reconhecidas.
      matchesIn(scope, PAGE_REVEAL).forEach((el) => {
        if (!(el instanceof HTMLElement) || rootsRevealed.has(el)) return;
        rootsRevealed.add(el);
        if (!motionOn) return;
        el.animate(
          [{ opacity: 0.94, filter: "blur(1.5px)" }, { opacity: 1, filter: "blur(0)" }],
          { duration: 390, easing: EASE, fill: "backwards" },
        );
      });
      // Cards novos (outras abas): entram agora se estiverem na tela.
      matchesIn(scope, EXTRA_REVEAL).forEach((el) => {
        if (revealed.has(el) || pending.has(el)) return;
        if (inViewport(el)) reveal(el, Math.min(index++ * 40, 320));
        else {
          pending.add(el);
          onScreen.observe(el);
        }
      });
      // Cards que motion-system.tsx ja animou na carga: so os que estao fora da
      // tela ficam esperando a rolagem.
      matchesIn(scope, KNOWN_REVEAL).forEach((el) => {
        if (revealed.has(el) || pending.has(el)) return;
        if (inViewport(el)) {
          revealed.add(el);
          return;
        }
        pending.add(el);
        onScreen.observe(el);
      });
      matchesIn(scope, VALUE_SELECTOR).forEach((value) => {
        if (inViewport(value)) countUp(value);
      });
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const parent = mutation.target.parentElement;
          if (parent && motionOn && parent.matches(BADGE_SELECTOR)) {
            parent.animate(
              [{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1)" }],
              { duration: 480, easing: SPRING },
            );
          }
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            if (!layers.includes(node)) register(node);
          } else if (node.nodeType === 3 && node.parentElement?.matches(VALUE_SELECTOR)) {
            countUp(node.parentElement);
          }
        });
      }
    });

    const onPointerMove = (event: PointerEvent) => {
      lastMove = performance.now();
      grid.style.setProperty("--ml-x", `${event.clientX}px`);
      grid.style.setProperty("--ml-y", `${event.clientY}px`);
      if (!motionOn || !(event.target instanceof Element)) return;

      const card = event.target.closest(".card");
      if (card instanceof HTMLElement) {
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--ml-mx", `${event.clientX - rect.left}px`);
        card.style.setProperty("--ml-my", `${event.clientY - rect.top}px`);
      }

      const metric = event.target.closest(".metric");
      const next = metric instanceof HTMLElement ? metric : null;
      if (next !== tilted) {
        tilted?.style.removeProperty("--ml-rx");
        tilted?.style.removeProperty("--ml-ry");
        tilted = next;
      }
      if (next) {
        const rect = next.getBoundingClientRect();
        next.style.setProperty("--ml-rx", `${(-((event.clientY - rect.top) / rect.height - 0.5) * 8).toFixed(2)}deg`);
        next.style.setProperty("--ml-ry", `${(((event.clientX - rect.left) / rect.width - 0.5) * 10).toFixed(2)}deg`);
      }
    };

    // Sem mouse por 3s (ou no celular), o foco de luz da malha passeia sozinho.
    const drift = window.setInterval(() => {
      if (level === "off" || overlay || document.hidden || performance.now() - lastMove < 3000) return;
      const t = performance.now() / 1000;
      grid.style.setProperty("--ml-x", `${window.innerWidth * (0.6 + 0.28 * Math.sin(t * 0.22))}px`);
      grid.style.setProperty("--ml-y", `${window.innerHeight * (0.35 + 0.25 * Math.cos(t * 0.3))}px`);
    }, 80);

    // Troca de pagina e de aba interna muda quem cobre o fundo.
    const overlayCheck = window.setInterval(checkOverlay, 2000);

    // Tema claro desliga o fundo; voltar ao escuro religa o desenho.
    const themeObserver = new MutationObserver(startLoop);
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    const onVisibility = () => startLoop();
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key.startsWith("agency-ops:")) applyPreferences();
    };

    applyPreferences();
    register(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(MOTION_EVENT, applyPreferences);
    window.addEventListener("storage", onStorage);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(drift);
      window.clearInterval(overlayCheck);
      observer.disconnect();
      themeObserver.disconnect();
      onScreen.disconnect();
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(MOTION_EVENT, applyPreferences);
      window.removeEventListener("storage", onStorage);
      layers.forEach((el) => el.remove());
      delete root.dataset.animations;
      delete root.dataset.motionLive;
      delete root.dataset.motionBg;
    };
  }, []);

  return null;
}
