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

export default function MotionSystem() {
  useEffect(() => {
    const root = document.documentElement;
    if (prefersReducedMotion()) {
      root.dataset.motion = "reduced";
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
