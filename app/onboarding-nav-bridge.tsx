"use client";

import { useEffect } from "react";

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

function stageOrder(label: string) {
  const value = normalize(label);
  if (value.includes("1a reuniao de apresentacao") || value.includes("1ª reuniao de apresentacao")) return 10;
  if (value.includes("formulario")) return 20;
  if (value.includes("reuniao de integracao")) return 30;
  if (value.includes("campanha no ar") || value.includes("primeira campanha")) return 40;
  // Etapas complementares continuam visiveis, mas nunca quebram os quatro marcos
  // definidos pela operacao: apresentacao -> formulario -> integracao -> campanha.
  return 100;
}

function ensureCanonicalOnboardingOrder() {
  const workspaces = Array.from(document.querySelectorAll<HTMLElement>(".workspace"));
  const workspace = workspaces.find((node) => normalize(node.querySelector(".workspace-head h2")?.textContent || "") === "funil de onboarding");
  const funnel = workspace?.querySelector<HTMLElement>(".funnel");
  if (!funnel) return;

  // Placeholder e' controlado por este bridge; nunca entra na leitura das etapas reais.
  const stages = Array.from(funnel.querySelectorAll<HTMLElement>(":scope > .stage:not(.onboarding-form-placeholder)"));
  if (!stages.length) return;

  let hasForm = false;
  let extraOrder = 100;
  for (const stage of stages) {
    const title = stage.querySelector<HTMLElement>(".stage-title > span");
    const label = title?.textContent || "";
    const order = stageOrder(label);
    if (order === 20) {
      hasForm = true;
      if (title) title.textContent = "Formulário";
    }
    stage.style.order = String(order === 100 ? extraOrder++ : order);
  }

  let placeholder = funnel.querySelector<HTMLElement>(":scope > .onboarding-form-placeholder");
  if (hasForm) {
    placeholder?.remove();
    return;
  }

  if (!placeholder) {
    placeholder = document.createElement("section");
    placeholder.className = "card stage onboarding-form-placeholder";
    placeholder.setAttribute("aria-label", "Formulário — nenhum cliente nesta etapa");
    placeholder.innerHTML = `
      <div class="stage-title"><span>Formulário</span><b>0</b></div>
      <div class="stage-bar"><i style="width:8%"></i></div>
      <div class="empty compact">Nenhum cliente nesta etapa.</div>
    `;
    funnel.appendChild(placeholder);
  }
  placeholder.style.order = "20";
}

export default function OnboardingNavBridge() {
  useEffect(() => {
    let frame = 0;
    const scheduleOrder = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(ensureCanonicalOnboardingOrder);
    };

    // O board antigo do dashboard pode ser re-renderizado a cada sincronizacao.
    // Reaplica apenas ordem/placeholder, sem tocar nos dados dos cards.
    const observer = new MutationObserver(scheduleOrder);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleOrder();

    const handler = (event: MouseEvent) => {
      if (window.location.pathname === "/onboarding") return;
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (!target) return;
      const label = normalize(target.textContent || "");
      // O item do menu pode conter badge (ex.: "Onboarding 9").
      // Antes o match exato falhava e mantinha o usuário no funil embutido antigo.
      if (!label.startsWith("onboarding")) return;
      const nav = target.closest("nav, .view-nav, .side-nav, .sidenav, .sidebar");
      if (!nav) return;
      event.preventDefault();
      event.stopPropagation();
      window.location.assign("/onboarding");
    };
    document.addEventListener("click", handler, true);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.removeEventListener("click", handler, true);
    };
  }, []);
  return null;
}
