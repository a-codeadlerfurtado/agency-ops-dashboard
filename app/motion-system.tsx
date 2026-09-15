"use client";

import { useEffect } from "react";

const REVEAL_SELECTOR = [
  ".card",
  ".action-card",
  ".ops-cockpit-lane",
  ".ops-monitor-list > button",
  ".ops-sla-list > button",
  ".ops-incident",
  ".ops-integrity-grid article",
  ".stage button",
  ".health-item",
  ".metric",
].join(",");

const SURFACE_SELECTOR = [
  ".ops-search-modal",
  ".ops-360",
  "[role='dialog']",
].join(",");

const INTERACTIVE_SELECTOR = "button,a,[role='button'],.action-card,.stage button";
const WORK_SLA_COLLAPSED_KEY = "agency-ops:work-sla-collapsed";

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateReveal(elements: Element[], seen: WeakSet<Element>) {
  const fresh = elements.filter((element) => !seen.has(element)).slice(0, 32);
  fresh.forEach((element) => seen.add(element));

  fresh.forEach((element, index) => {
    if (!(element instanceof HTMLElement)) return;
    element.animate(
      [
        {
          opacity: 0,
          transform: "translate3d(0, 14px, 0) scale(.985)",
          filter: "blur(4px)",
        },
        {
          opacity: 1,
          transform: "translate3d(0, 0, 0) scale(1)",
          filter: "blur(0px)",
        },
      ],
      {
        duration: 520,
        delay: Math.min(index * 34, 340),
        easing: "cubic-bezier(.16, 1, .3, 1)",
        fill: "backwards",
      },
    );
  });
}

function animateSurface(element: Element, seen: WeakSet<Element>) {
  if (!(element instanceof HTMLElement) || seen.has(element)) return;
  seen.add(element);

  const isDrawer = element.classList.contains("ops-360");
  element.animate(
    isDrawer
      ? [
          { opacity: 0, transform: "translate3d(34px, 0, 0)" },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ]
      : [
          { opacity: 0, transform: "translate3d(0, 10px, 0) scale(.975)" },
          { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
        ],
    {
      duration: 380,
      easing: "cubic-bezier(.16, 1, .3, 1)",
      fill: "backwards",
    },
  );
}

function collectMatches(root: ParentNode, selector: string) {
  const matches: Element[] = [];
  if (root instanceof Element && root.matches(selector)) matches.push(root);
  matches.push(...Array.from(root.querySelectorAll(selector)));
  return matches;
}

function enhanceRetractableWorkSla() {
  const panels = Array.from(document.querySelectorAll("#ops-work-sla-slot .ops-sla.card"));

  panels.forEach((panel) => {
    if (!(panel instanceof HTMLElement)) return;
    const header = panel.querySelector(".ops-monitor-head");
    const list = panel.querySelector(".ops-sla-list");
    if (!(header instanceof HTMLElement) || !(list instanceof HTMLElement)) return;

    const existingToggle = panel.querySelector(".ops-work-sla-toggle");
    if (existingToggle) return;

    panel.dataset.retractable = "true";
    list.style.overflow = "hidden";
    list.style.transition = "max-height 240ms cubic-bezier(.16,1,.3,1), opacity 180ms ease, margin-top 240ms cubic-bezier(.16,1,.3,1)";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ops-work-sla-toggle";
    toggle.style.cssText = [
      "flex:0 0 auto",
      "width:36px",
      "height:36px",
      "margin-left:10px",
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "border:1px solid var(--line)",
      "border-radius:12px",
      "background:color-mix(in srgb,var(--panel2) 88%,transparent)",
      "color:var(--muted)",
      "font-size:18px",
      "line-height:1",
      "cursor:pointer",
    ].join(";");

    let collapsed = false;
    try {
      collapsed = window.localStorage.getItem(WORK_SLA_COLLAPSED_KEY) === "1";
    } catch {
      collapsed = false;
    }

    const render = (animate = true) => {
      panel.dataset.collapsed = collapsed ? "true" : "false";
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.setAttribute("aria-label", collapsed ? "Expandir fila por tempo em aberto" : "Recolher fila por tempo em aberto");
      toggle.title = collapsed ? "Expandir" : "Recolher";
      toggle.textContent = collapsed ? "▾" : "▴";

      if (!animate) list.style.transition = "none";
      list.style.maxHeight = collapsed ? "0px" : "2400px";
      list.style.opacity = collapsed ? "0" : "1";
      list.style.marginTop = collapsed ? "0" : "";
      list.style.pointerEvents = collapsed ? "none" : "";
      list.setAttribute("aria-hidden", collapsed ? "true" : "false");
      if (!animate) {
        window.requestAnimationFrame(() => {
          list.style.transition = "max-height 240ms cubic-bezier(.16,1,.3,1), opacity 180ms ease, margin-top 240ms cubic-bezier(.16,1,.3,1)";
        });
      }
    };

    toggle.addEventListener("click", () => {
      collapsed = !collapsed;
      try {
        window.localStorage.setItem(WORK_SLA_COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch {
        // A preferência é apenas conveniência visual; a Central continua funcionando sem storage.
      }
      render(true);
    });

    header.appendChild(toggle);
    render(false);
  });
}

export default function MotionSystem() {
  useEffect(() => {
    const root = document.documentElement;
    if (prefersReducedMotion()) {
      root.dataset.motion = "reduced";
      enhanceRetractableWorkSla();
      return;
    }

    root.dataset.motion = "enhanced";
    const seenReveal = new WeakSet<Element>();
    const seenSurface = new WeakSet<Element>();

    const initialFrame = window.requestAnimationFrame(() => {
      animateReveal(Array.from(document.querySelectorAll(REVEAL_SELECTOR)), seenReveal);
      Array.from(document.querySelectorAll(SURFACE_SELECTOR)).forEach((element) =>
        animateSurface(element, seenSurface),
      );
      enhanceRetractableWorkSla();
    });

    const observer = new MutationObserver((mutations) => {
      const reveal: Element[] = [];
      const surfaces: Element[] = [];

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          reveal.push(...collectMatches(node, REVEAL_SELECTOR));
          surfaces.push(...collectMatches(node, SURFACE_SELECTOR));
        });
      }

      if (reveal.length) animateReveal(reveal, seenReveal);
      surfaces.forEach((element) => animateSurface(element, seenSurface));
      enhanceRetractableWorkSla();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null;
      if (!(target instanceof HTMLElement) || target.matches(":disabled")) return;
      target.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(.982)" },
          { transform: "scale(1)" },
        ],
        {
          duration: 210,
          easing: "cubic-bezier(.34, 1.56, .64, 1)",
        },
      );
    };

    const onVisibilityChange = () => {
      root.dataset.windowActive = document.hidden ? "false" : "true";
    };

    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();

    return () => {
      window.cancelAnimationFrame(initialFrame);
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      delete root.dataset.motion;
      delete root.dataset.windowActive;
    };
  }, []);

  return null;
}
