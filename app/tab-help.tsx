"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Row } from "./shared";

type HelpDefinition = {
  title: string;
  purpose: string;
  howToUse: string[];
};

const HELP: Record<string, HelpDefinition> = {
  overview: {
    title: "Visão geral",
    purpose: "Resume o que merece atenção agora sem obrigar você a abrir cada módulo do dashboard.",
    howToUse: [
      "Use os indicadores para identificar prioridades, riscos e pendências do seu escopo.",
      "Abra um cliente ou uma ação quando precisar sair do resumo e investigar o detalhe.",
      "Os números desta tela devem respeitar o seu perfil: ela não é uma visão global para todo mundo.",
    ],
  },
  focus: {
    title: "Foco do dia",
    purpose: "Transforma tarefas, prazos, alertas e próximas ações em uma fila prática do que você precisa fazer agora.",
    howToUse: [
      "Comece por itens vencidos, críticos ou com prazo de hoje.",
      "As tarefas do ClickUp são ligadas ao usuário real do seu perfil e continuam sendo executadas/concluídas no ClickUp.",
      "Quando uma task não tiver cliente perfeitamente vinculado, ela deve continuar aparecendo em vez de sumir silenciosamente.",
    ],
  },
  work: {
    title: "Central de Trabalho",
    purpose: "Centraliza solicitações entre colaboradores e mantém o histórico de quem pediu, quem recebeu, prazo, prioridade e conclusão.",
    howToUse: [
      "Use “Nova solicitação” quando precisar acionar outro colaborador ou área.",
      "A solicitação é o objeto de trabalho; a notificação é apenas o aviso enviado a quem precisa agir.",
      "Atualize o status e registre a conclusão para que o pedido não se perca em mensagens soltas.",
    ],
  },
  clients: {
    title: "Clientes",
    purpose: "Mostra os clientes aos quais o seu perfil tem acesso e as informações necessárias para trabalhar com eles.",
    howToUse: [
      "Use a busca para localizar rapidamente cliente ou responsável.",
      "As informações exibidas mudam conforme o cargo para evitar excesso de dados e acesso indevido.",
      "Relacionamentos como GT, CS e tempo de casa devem vir do banco, nunca de texto fixo no frontend.",
    ],
  },
  creative: {
    title: "Central Criativa",
    purpose: "Concentra regras, identidade visual, restrições e evidências que precisam ser respeitadas na produção criativa de cada cliente.",
    howToUse: [
      "Em “Por Clientes”, consulte todas as particularidades de um cliente específico.",
      "Em “Por Regras”, procure uma diretriz e veja a quais clientes ela se aplica.",
      "Material histórico não deve virar regra fixa sem confirmação; priorize regras e evidências validadas.",
    ],
  },
  health: {
    title: "Saúde",
    purpose: "Ajuda a identificar clientes em risco, sinais de atenção e pontos que precisam de acompanhamento antes de virarem problema maior.",
    howToUse: [
      "Use os sinais como diagnóstico e ponto de partida para investigação, não como julgamento automático do cliente.",
      "Cruze saúde com histórico, conversas, campanhas e próximas ações antes de tomar uma decisão.",
      "O escopo de clientes continua respeitando o seu cargo e sua carteira/responsabilidade.",
    ],
  },
  onboarding: {
    title: "Onboarding",
    purpose: "Acompanha o avanço dos novos clientes desde a apresentação inicial até a primeira campanha publicada.",
    howToUse: [
      "Confira qual etapa já possui evidência e qual é a próxima ação real.",
      "Não marque etapas como concluídas apenas por tempo decorrido: use evidências do processo sempre que existirem.",
      "Depois da primeira campanha publicada, o cliente deve sair do onboarding.",
    ],
  },
  campaigns: {
    title: "Campanhas",
    purpose: "Reúne a situação operacional das campanhas e ajuda a encontrar clientes com mídia desatualizada, ausência de atividade ou necessidade de ação.",
    howToUse: [
      "Use filtros e períodos para comparar a situação atual sem misturar clientes fora do seu escopo.",
      "Clientes churned não devem poluir a visão operacional padrão de campanhas ativas.",
      "Quando houver um problema, use o dashboard para diagnosticar e o gerenciador/fluxo oficial para executar a correção.",
    ],
  },
  contracts: {
    title: "Contratos",
    purpose: "Área administrativa para consultar informações contratuais que não devem ficar expostas aos demais perfis.",
    howToUse: [
      "Use esta aba para conferência e acompanhamento de informações contratuais autorizadas.",
      "O acesso é protegido no backend; esconder o botão no menu não é a barreira de segurança.",
      "Não copie dados contratuais para módulos operacionais sem necessidade.",
    ],
  },
  preclients: {
    title: "Pré-clientes",
    purpose: "Acompanha oportunidades e clientes ainda anteriores à operação regular, sem misturá-los com a carteira ativa.",
    howToUse: [
      "Use esta visão para entender em que ponto está cada oportunidade antes da entrada formal na operação.",
      "Mantenha pré-clientes separados dos clientes ativos para não distorcer métricas operacionais.",
      "Quando houver avanço de etapa, registre a mudança na fonte correta do processo comercial.",
    ],
  },
  conversations: {
    title: "Conversas",
    purpose: "Organiza sinais e pendências das conversas com clientes para identificar quem está esperando resposta e qual contexto precisa de acompanhamento.",
    howToUse: [
      "Priorize conversas em que o cliente falou por último e ainda não recebeu retorno da agência.",
      "Leia o contexto antes de responder; o dashboard ajuda a localizar a pendência, não substitui o canal oficial da conversa.",
      "O seu perfil só deve receber conversas dos clientes que fazem parte do seu escopo.",
    ],
  },
  team: {
    title: "Equipe",
    purpose: "Dá uma visão de capacidade, responsabilidades, carteiras e produtividade para apoiar decisões de gestão da operação.",
    howToUse: [
      "Use esta aba para encontrar sobrecarga, vínculos ausentes e desequilíbrios de carteira.",
      "Diferencie falta de dados de baixa produtividade antes de tirar conclusões.",
      "Ex-colaboradores devem permanecer preservados no histórico, mas não aparecer como membros ativos.",
    ],
  },
  diary: {
    title: "Diário",
    purpose: "Separa o histórico do que cada colaborador executou do histórico de problemas que geraram ajuste ou retrabalho.",
    howToUse: [
      "TaskLog: registre o que você fez ou está fazendo na operação.",
      "Diário de Ajustes: registre o que precisou ser corrigido e, principalmente, por que o ajuste aconteceu.",
      "Cada colaborador vê os próprios registros; a visão consolidada de todos os autores é administrativa.",
    ],
  },
  clickup: {
    title: "ClickUp",
    purpose: "Traz para o dashboard as tarefas e indicadores necessários para diagnóstico de produtividade sem transformar o dashboard em um segundo ClickUp.",
    howToUse: [
      "Use a aba para acompanhar volume, prazo, conclusão e vínculo das tarefas com clientes e pessoas.",
      "A execução e a conclusão continuam no ClickUp, que permanece como fonte oficial da tarefa.",
      "Indicadores devem ser autoexplicativos; números como X/Y precisam dizer exatamente o que numerador e denominador representam.",
    ],
  },
  evidence: {
    title: "Evidências",
    purpose: "Permite revisar evidências e sinais que precisam de validação humana antes de virarem informação operacional definitiva.",
    howToUse: [
      "Confira a fonte e o contexto antes de confirmar uma evidência.",
      "Não transforme inferência, material histórico ou texto ambíguo em fato sem validação.",
      "Use esta área para aumentar a qualidade do banco, não apenas para zerar uma fila.",
    ],
  },
  audit: {
    title: "Auditoria",
    purpose: "Mostra verificações técnicas e inconsistências encontradas nas integrações, dados e rotinas do dashboard.",
    howToUse: [
      "Use os apontamentos para localizar a origem de uma inconsistência antes de corrigir o frontend.",
      "Diferencie erro de integração, dado ausente, permissão e problema visual.",
      "Preserve rastreabilidade: correções de dados devem ser feitas na fonte correta sempre que possível.",
    ],
  },
  alerts: {
    title: "Alertas",
    purpose: "Destaca situações que exigem atenção operacional e oferece um caminho rápido para encaminhar, analisar ou acompanhar o problema.",
    howToUse: [
      "Abra o alerta para entender a evidência e o cliente afetado antes de agir.",
      "Use a Central de Trabalho quando o alerta precisar virar uma solicitação para outra pessoa.",
      "Marque como analisado, adie ou descarte apenas quando houver contexto suficiente para isso.",
    ],
  },
  opsperf: {
    title: "Desempenho OP",
    purpose: "Consolida indicadores de desempenho operacional para gestão, diagnóstico de gargalos e melhoria de processo.",
    howToUse: [
      "Compare períodos e pessoas sem ignorar diferenças de função, carteira e volume de trabalho.",
      "Use indicadores como ponto de investigação; eles não substituem contexto operacional.",
      "Priorize padrões recorrentes e gargalos que possam ser resolvidos por processo, automação ou treinamento.",
    ],
  },
  ai: {
    title: "IA",
    purpose: "Espaço de consulta assistida que usa o contexto e as permissões do seu perfil para ajudar a investigar a operação.",
    howToUse: [
      "Selecione um cliente quando quiser que a conversa considere o contexto daquele cliente.",
      "Use o modo geral para perguntas sobre a operação como um todo dentro do seu nível de acesso.",
      "A IA ajuda a analisar e organizar informação; ações críticas continuam dependendo das ferramentas e permissões oficiais.",
    ],
  },
};

const ROLE_LABEL: Record<string, string> = {
  GT: "Gestor de Tráfego",
  CS: "CS",
  DESIGN: "Designer",
  MGMT: "Operações / Gestão",
  AI: "IA / Operações",
};

function scopeFor(view: string, profile: Row) {
  const role = String(profile?.role || "").toUpperCase();
  const person = String(profile?.person || "");
  const carteira = profile?.carteira ? ` (${profile.carteira})` : "";
  const isAdler = person === "Adler Furtado" || (role === "MGMT" && Boolean(profile?.elevated || profile?.access_level === "FULL"));

  if (isAdler) {
    if (view === "diary") return "No seu perfil, o Diário inicia em “Meus registros”. A visão “Todos os registros” é administrativa e deve identificar o autor de cada entrada.";
    if (view === "alerts") return "Você pode consultar o consolidado da operação. Use filtros e identificação de responsável para não confundir alertas de equipes ou carteiras diferentes.";
    if (view === "clients" || view === "overview" || view === "health" || view === "campaigns") return "Seu perfil administrativo pode acessar a visão consolidada. Quando houver filtros por pessoa, carteira ou cliente, eles alteram o escopo dos indicadores exibidos.";
    return "Seu perfil possui visão administrativa mais ampla. Use o consolidado para gestão, mantendo autoria, carteira e responsabilidade explícitas em cada registro.";
  }

  if (role === "GT") {
    if (["overview", "clients", "health", "onboarding", "campaigns", "conversations", "alerts"].includes(view)) return `Como GT, você deve ver somente os clientes da sua própria carteira${carteira}. Nada desta aba deve abrir dados globais da agência.`;
    if (view === "focus") return `Seu Foco do dia combina suas tarefas pessoais do ClickUp com prioridades e sinais dos clientes da sua carteira${carteira}.`;
    if (view === "clickup") return "Os indicadores pessoais devem ser ligados ao seu ClickUp User ID real, evitando confusão por nomes semelhantes ou abreviados.";
    if (view === "diary") return "Você vê somente os seus registros pessoais de TaskLog e Diário de Ajustes. Registros de outros colaboradores não pertencem ao seu histórico.";
  }

  if (role === "DESIGN") {
    if (view === "focus") return "Como Designer, esta é sua tela principal: prioriza apenas demandas de design atribuídas a você, incluindo tarefas reais do seu usuário no ClickUp.";
    if (view === "clients") return "Como Designer, a visão de Clientes é propositalmente enxuta: Cliente, Gestor de Tráfego e Tempo conosco. Dados gerenciais ficam fora deste perfil.";
    if (view === "creative") return "Esta é a sua fonte principal para identidade visual e particularidades criativas. Confira as regras antes de produzir ou revisar uma peça.";
    if (view === "clickup") return "Sua produtividade e tarefas devem ser calculadas a partir do seu ClickUp User ID real, sem misturar entregas de outros designers.";
    if (view === "diary") return "TaskLog registra sua execução; Diário de Ajustes registra retrabalho/correções e a causa. Você não deve receber registros pessoais de outro colaborador.";
    if (view === "work") return "Use a Central de Trabalho para receber solicitações da operação e encaminhar pedidos que precisem de outra pessoa, sem transformar o Diário em fila de tarefas.";
  }

  if (role === "CS") {
    if (["overview", "clients", "health", "onboarding", "conversations", "alerts"].includes(view)) return "Como CS, o conteúdo deve estar relacionado aos clientes sob sua responsabilidade. A aba ajuda a acompanhar relação, pendências e risco sem abrir a operação inteira.";
    if (view === "focus") return "Seu Foco do dia prioriza retornos, compromissos, follow-ups e tarefas pessoais que dependem da sua ação.";
    if (view === "diary") return "Se fez uma atividade, use TaskLog. Se algo precisou ser corrigido ou gerou retrabalho, use Diário de Ajustes e registre a causa.";
  }

  return `Esta ajuda considera o perfil ${ROLE_LABEL[role] || role || "do usuário"}. O conteúdo da aba deve sempre respeitar as permissões e o escopo definidos no backend.`;
}

export function TabHelp({ view, profile = {} }: { view: string; profile?: Row }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const definition = HELP[view] || {
    title: "Esta aba",
    purpose: "Reúne informações e ações desta parte da operação.",
    howToUse: ["Use os dados exibidos dentro do escopo permitido para o seu perfil."],
  };
  const scope = useMemo(() => scopeFor(view, profile), [view, profile?.role, profile?.person, profile?.carteira, profile?.access_level, profile?.elevated]);
  const role = String(profile?.role || "").toUpperCase();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ position: "fixed", top: 82, right: 22, zIndex: 95, display: "flex", justifyContent: "flex-end" }}
    >
      <button
        type="button"
        aria-label={`Sobre a aba ${definition.title}`}
        aria-expanded={open}
        title="Sobre esta aba"
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setOpen(true)}
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "1px solid rgba(148,163,184,.38)",
          background: "rgba(15,23,42,.96)",
          color: "#e2e8f0",
          fontSize: 16,
          fontWeight: 800,
          lineHeight: 1,
          cursor: "help",
          boxShadow: "0 8px 24px rgba(0,0,0,.28)",
        }}
      >
        ?
      </button>

      {open && (
        <aside
          role="dialog"
          aria-label={`Ajuda: ${definition.title}`}
          style={{
            position: "absolute",
            top: 40,
            right: 0,
            width: "min(390px, calc(100vw - 28px))",
            maxHeight: "min(70vh, 560px)",
            overflow: "auto",
            padding: 16,
            borderRadius: 14,
            border: "1px solid rgba(148,163,184,.24)",
            background: "rgba(9,15,28,.985)",
            color: "#e5e7eb",
            boxShadow: "0 20px 55px rgba(0,0,0,.42)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 4 }}>Sobre esta aba</div>
              <strong style={{ fontSize: 17, color: "#f8fafc" }}>{definition.title}</strong>
            </div>
            <span style={{ fontSize: 11, border: "1px solid rgba(148,163,184,.22)", borderRadius: 999, padding: "4px 7px", color: "#cbd5e1", whiteSpace: "nowrap" }}>
              {ROLE_LABEL[role] || role || "Seu perfil"}
            </span>
          </div>

          <p style={{ margin: "12px 0", fontSize: 13, lineHeight: 1.55, color: "#cbd5e1" }}>{definition.purpose}</p>

          <div style={{ background: "rgba(59,130,246,.08)", border: "1px solid rgba(59,130,246,.2)", borderRadius: 10, padding: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#93c5fd", marginBottom: 4 }}>No seu perfil</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#dbeafe" }}>{scope}</div>
          </div>

          <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94a3b8", marginBottom: 7 }}>Como usar</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 7, fontSize: 12.5, lineHeight: 1.5, color: "#cbd5e1" }}>
            {definition.howToUse.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </aside>
      )}
    </div>
  );
}
