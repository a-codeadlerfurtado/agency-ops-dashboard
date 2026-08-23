"use client";

// Aba "Desempenho OP" - visao acumulada, diaria e por carteira de GT.
import { createElement as h, useEffect, useMemo, useState } from "react";
import { api, authenticatedFetch, SUPABASE_URL } from "../shared";
import { WalletPerformanceCenter } from "./wallet-performance";

const DAILY_PERF_URL = `${SUPABASE_URL}/functions/v1/agency-ops-opsperf-daily-api`;
const MUTED = { color: "#8aa3c0" };
const ROLE_LABEL: Record<string, string> = { CS: "CS", DESIGN: "Design", GT: "Gestor de tráfego", MGMT: "Gestão", AI: "IA" };

function formatHours(hours: any) {
  if (hours === null || hours === undefined) return "—";
  if (hours < 24) return Number(hours).toFixed(1) + "h";
  return (Number(hours) / 24).toFixed(1) + "d";
}
function formatMinutes(min: any) {
  if (min === null || min === undefined) return "—";
  if (min < 60) return Math.round(Number(min)) + " min";
  return (Number(min) / 60).toFixed(1) + "h";
}
function todaySaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function formatDayLabel(day: string) {
  const text = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildHeatmapWeeks(activity: any, since: any) {
  const start = new Date(since + "T00:00:00Z");
  const startDow = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - startDow);
  const days = [];
  const cursor = new Date(start);
  const today = new Date();
  while (cursor <= today) {
    const iso = cursor.toISOString().slice(0, 10);
    days.push({ date: iso, count: activity[iso] || 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}
function levelColor(count: any) {
  if (count <= 0) return "rgba(255,255,255,.06)";
  if (count === 1) return "#0e4429";
  if (count <= 3) return "#006d32";
  if (count <= 6) return "#26a641";
  return "#39d353";
}
function currentStreak(activity: any) {
  let streak = 0;
  const cursor = new Date();
  const todayIso = cursor.toISOString().slice(0, 10);
  for (;;) {
    const iso = cursor.toISOString().slice(0, 10);
    if ((activity[iso] || 0) > 0) { streak += 1; cursor.setUTCDate(cursor.getUTCDate() - 1); continue; }
    if (streak === 0 && iso === todayIso) { cursor.setUTCDate(cursor.getUTCDate() - 1); continue; }
    break;
  }
  return streak;
}

function PersonHeatmap(props: any) {
  const person = props.person;
  const activity = props.activity;
  const since = props.since;
  const weeks = useMemo(function () { return buildHeatmapWeeks(activity, since); }, [activity, since]);
  const streak = useMemo(function () { return currentStreak(activity); }, [activity]);
  let total = 0;
  for (const key in activity) total += activity[key];

  const weekCols = weeks.map(function (week, wi) {
    const cells = week.map(function (day) {
      return h("div", {
        key: day.date,
        title: day.date + ": " + day.count + (day.count === 1 ? " atividade" : " atividades"),
        style: { width: 10, height: 10, borderRadius: 2, background: levelColor(day.count) },
      });
    });
    return h("div", { key: wi, style: { display: "flex", flexDirection: "column", gap: 3 } }, cells);
  });

  return h("div", { className: "card section", style: { marginBottom: 12 } }, [
    h("div", { key: "hd", style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8, gap: 12 } }, [
      h("b", { key: "n" }, person),
      h("small", { key: "s", style: MUTED }, total + " atividades nos últimos 12 meses · sequência atual: " + streak + (streak === 1 ? " dia" : " dias")),
    ]),
    h("div", { key: "grid", style: { display: "flex", gap: 3, overflowX: "auto", paddingBottom: 4 } }, weekCols),
  ]);
}

function statBlock(key: any, label: any, valueNode: any) {
  return h("div", { key: key, style: { minWidth: 112 } }, [
    h("small", { key: "l", style: MUTED }, label),
    h("div", { key: "v", style: { fontSize: 20, fontWeight: 650, marginTop: 2 } }, valueNode),
  ]);
}

function PersonCard(props: any) {
  const row = props.row;
  const blocks = [
    statBlock("tc", "Tasks concluídas", String(row.tasks_completed)),
    statBlock("to", "Em aberto agora", [
      String(row.tasks_open),
      row.overdue_tasks > 0 ? h("span", { key: "od", style: { color: "#ff6b75", fontSize: 13, marginLeft: 6 } }, "(" + row.overdue_tasks + (row.overdue_tasks === 1 ? " atrasada)" : " atrasadas)")) : null,
    ]),
    statBlock("ot", "No prazo", row.on_time_rate === null ? "—" : row.on_time_rate + "%"),
  ];
  if (row.role === "DESIGN" || row.role === "GT") {
    blocks.push(statBlock("hn", "Entrega · criativo novo", [formatHours(row.avg_hours_novo), h("small", { key: "c", style: MUTED }, " (" + row.creatives_novo + ")")]));
    blocks.push(statBlock("ha", "Entrega · ajuste", [formatHours(row.avg_hours_ajuste), h("small", { key: "c", style: MUTED }, " (" + row.creatives_ajuste + ")")]));
  }
  if (row.role === "CS") {
    blocks.push(statBlock("cs", "Resposta média ao cliente", [formatMinutes(row.avg_cs_response_minutes), h("small", { key: "c", style: MUTED }, " (" + row.cs_replies + ")")]));
  }
  return h("div", { className: "card section", style: { marginBottom: 12 } }, [
    h("div", { key: "hd", style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } }, [
      h("b", { key: "n" }, row.person),
      h("span", { key: "r", className: "chip" }, ROLE_LABEL[row.role] || row.role),
    ]),
    h("div", { key: "stats", style: { display: "flex", flexWrap: "wrap", gap: 18, marginTop: 10 } }, blocks),
  ]);
}

function DailyPersonCard({ row }: { row: any }) {
  const hasActivity = row.total_activity > 0 || row.tasks_completed > 0 || row.cs_replies > 0;
  const blocks = [
    statBlock("act", "Eventos rastreados", String(row.total_activity)),
    statBlock("tasks", "Tasks concluídas", String(row.tasks_completed)),
    statBlock("logs", "Registros no TaskLog", String(row.task_log_entries)),
    statBlock("adj", "Ajustes registrados", String(row.adjustments)),
    statBlock("ontime", "Tasks no prazo", row.on_time_rate === null ? "—" : row.on_time_rate + "%"),
  ];
  if (row.role === "DESIGN" || row.role === "GT") {
    blocks.push(statBlock("novo", "Criativo novo · tempo médio", [formatHours(row.avg_hours_novo), h("small", { key: "n", style: MUTED }, ` (${row.creatives_novo})`)]));
    blocks.push(statBlock("ajuste", "Ajuste · tempo médio", [formatHours(row.avg_hours_ajuste), h("small", { key: "a", style: MUTED }, ` (${row.creatives_ajuste})`)]));
  }
  if (row.role === "CS") {
    blocks.push(statBlock("reply", "Resposta média ao cliente", [formatMinutes(row.avg_cs_response_minutes), h("small", { key: "r", style: MUTED }, ` (${row.cs_replies})`)]));
  }

  const taskList = (row.completed_tasks || []).length
    ? h("div", { key: "task-list", style: { marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(148,163,184,.12)" } }, [
        h("small", { key: "title", style: { ...MUTED, display: "block", marginBottom: 6 } }, "Tasks concluídas no dia"),
        h("div", { key: "items", style: { display: "grid", gap: 5 } }, (row.completed_tasks || []).map((task: any) =>
          h("div", { key: task.task_id, style: { fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 12 } }, [
            h("span", { key: "name" }, task.task_name || "Task sem nome"),
            h("small", { key: "status", style: { color: task.on_time === false ? "#ff8a92" : "#8aa3c0", whiteSpace: "nowrap" } }, task.on_time === false ? "fora do prazo" : task.on_time === true ? "no prazo" : "sem prazo"),
          ])
        )),
        row.tasks_completed > (row.completed_tasks || []).length ? h("small", { key: "more", style: { ...MUTED, display: "block", marginTop: 6 } }, `+ ${row.tasks_completed - row.completed_tasks.length} outras concluídas`) : null,
      ])
    : null;

  return h("div", { className: "card section", style: { marginBottom: 12, opacity: hasActivity ? 1 : .72 } }, [
    h("div", { key: "hd", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } }, [
      h("div", { key: "who", style: { display: "flex", alignItems: "center", gap: 8 } }, [
        h("b", { key: "name" }, row.person),
        h("span", { key: "role", className: "chip" }, ROLE_LABEL[row.role] || row.role),
      ]),
      h("small", { key: "status", style: { color: hasActivity ? "#86efac" : "#8aa3c0" } }, hasActivity ? "atividade registrada" : "sem atividade registrada"),
    ]),
    h("div", { key: "stats", style: { display: "flex", flexWrap: "wrap", gap: 18, marginTop: 12 } }, blocks),
    taskList,
  ]);
}

function DailySummary({ summary }: { summary: any }) {
  const items = [
    ["Pessoas com atividade", summary.people_with_activity ?? 0],
    ["Eventos rastreados", summary.total_activity ?? 0],
    ["Tasks concluídas", summary.tasks_completed ?? 0],
    ["TaskLog", summary.task_log_entries ?? 0],
    ["Ajustes", summary.adjustments ?? 0],
  ];
  return h("div", { className: "card section", style: { marginBottom: 12 } }, [
    h("div", { key: "grid", style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(135px,1fr))", gap: 14 } }, items.map(([label, value]) =>
      h("div", { key: String(label) }, [
        h("small", { key: "l", style: MUTED }, String(label)),
        h("div", { key: "v", style: { fontSize: 24, fontWeight: 750, marginTop: 3 } }, String(value)),
      ])
    )),
  ]);
}

export function OpsPerfCenter(props: any) {
  const token = props.token;
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [mode, setMode] = useState<"people" | "daily" | "wallets">("people");
  const [dailyAllowed, setDailyAllowed] = useState(false);
  const [dailyData, setDailyData] = useState<any>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState("");
  const [dailyDate, setDailyDate] = useState(todaySaoPaulo());
  const [dailyRole, setDailyRole] = useState("ALL");
  const [dailyPerson, setDailyPerson] = useState("ALL");

  useEffect(function () {
    let cancelled = false;
    api("opsperf", token)
      .then(function (payload) { if (!cancelled) setData(payload); })
      .catch(function (err) { if (!cancelled) setError(String((err && err.message) || err)); });
    return function () { cancelled = true; };
  }, [token]);

  useEffect(function () {
    let cancelled = false;
    setDailyLoading(true);
    setDailyError("");
    const url = new URL(DAILY_PERF_URL);
    url.searchParams.set("date", dailyDate);
    authenticatedFetch(url, { cache: "no-store" })
      .then(async function (response) {
        const payload = await response.json().catch(function () { return null; });
        if (response.status === 403) {
          if (!cancelled) { setDailyAllowed(false); setDailyData(null); }
          return;
        }
        if (!response.ok || !payload?.ok) throw new Error(payload?.detail || payload?.error || `API ${response.status}`);
        if (!cancelled) { setDailyAllowed(true); setDailyData(payload); }
      })
      .catch(function (err) {
        if (!cancelled) setDailyError(String((err && err.message) || err));
      })
      .finally(function () { if (!cancelled) setDailyLoading(false); });
    return function () { cancelled = true; };
  }, [token, dailyDate]);

  useEffect(function () {
    if (!dailyAllowed && mode === "daily") setMode("people");
  }, [dailyAllowed, mode]);

  const modeButtons = [
    h("button", { key: "p", className: mode === "people" ? "active" : "", onClick: function () { setMode("people"); } }, "Colaboradores"),
    dailyAllowed ? h("button", { key: "d", className: mode === "daily" ? "active" : "", onClick: function () { setMode("daily"); } }, "Diário") : null,
    h("button", { key: "w", className: mode === "wallets" ? "active" : "", onClick: function () { setMode("wallets"); } }, "Carteiras de GT"),
  ].filter(Boolean);
  const modeTabs = h("div", { className: "filter-tabs", style: { marginBottom: 14 } }, modeButtons);

  if (mode === "wallets") {
    return h("section", { className: "workspace" }, [
      h("div", { key: "hd", className: "workspace-head" }, h("div", null, [
        h("h2", { key: "t" }, "Desempenho OP"),
        h("p", { key: "sub", style: { color: "#8aa3c0", margin: "4px 0 0" } }, "Compare a operação por carteira e abra Alfa, Bravo, Charlie ou qualquer nova carteira cadastrada."),
      ])),
      h("div", { key: "m" }, modeTabs),
      h(WalletPerformanceCenter, { key: "wallets" }),
    ]);
  }

  if (mode === "daily" && dailyAllowed) {
    const people = dailyData?.people || [];
    const roleSet: Record<string, boolean> = {};
    people.forEach(function (person: any) { roleSet[person.role] = true; });
    const roles = ["ALL"].concat(Object.keys(roleSet));
    const peopleForRole = dailyRole === "ALL" ? people : people.filter(function (person: any) { return person.role === dailyRole; });
    const peopleNames = peopleForRole.map(function (person: any) { return person.person; });
    const selectedPerson = dailyPerson !== "ALL" && peopleNames.includes(dailyPerson) ? dailyPerson : "ALL";
    const visible = peopleForRole.filter(function (person: any) { return selectedPerson === "ALL" || person.person === selectedPerson; });

    return h("section", { className: "workspace" }, [
      h("div", { key: "hd", className: "workspace-head" }, h("div", null, [
        h("h2", { key: "t" }, "Desempenho OP · diário"),
        h("p", { key: "sub", style: { color: "#8aa3c0", margin: "4px 0 0" } }, "Visão exclusiva da gestão. Eventos rastreados combinam ClickUp, TaskLog e ajustes registrados; métricas de prazo e tempo usam os dados reais disponíveis para cada função."),
      ])),
      h("div", { key: "m" }, modeTabs),
      h("div", { key: "controls", className: "card section", style: { marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" } }, [
        h("button", { key: "prev", className: "btn", onClick: function () { setDailyDate(shiftDay(dailyDate, -1)); } }, "← Dia anterior"),
        h("label", { key: "date", style: { display: "grid", gap: 4, minWidth: 170 } }, [
          h("small", { key: "l", style: MUTED }, "Data"),
          h("input", { key: "i", className: "control", type: "date", max: todaySaoPaulo(), value: dailyDate, onChange: function (event: any) { setDailyDate(event.target.value || todaySaoPaulo()); } }),
        ]),
        h("button", { key: "next", className: "btn", disabled: dailyDate >= todaySaoPaulo(), onClick: function () { setDailyDate(shiftDay(dailyDate, 1)); } }, "Próximo dia →"),
        h("button", { key: "today", className: "btn", onClick: function () { setDailyDate(todaySaoPaulo()); } }, "Hoje"),
        h("label", { key: "role", style: { display: "grid", gap: 4, minWidth: 150 } }, [
          h("small", { key: "l", style: MUTED }, "Função"),
          h("select", { key: "s", className: "control", value: dailyRole, onChange: function (event: any) { setDailyRole(event.target.value); setDailyPerson("ALL"); } }, roles.map(function (role) {
            return h("option", { key: role, value: role }, role === "ALL" ? "Todas" : (ROLE_LABEL[role] || role));
          })),
        ]),
        h("label", { key: "person", style: { display: "grid", gap: 4, minWidth: 190 } }, [
          h("small", { key: "l", style: MUTED }, "Colaborador"),
          h("select", { key: "s", className: "control", value: selectedPerson, onChange: function (event: any) { setDailyPerson(event.target.value); } }, [
            h("option", { key: "all", value: "ALL" }, "Todos"),
            ...peopleForRole.map(function (person: any) { return h("option", { key: person.person, value: person.person }, person.person); }),
          ]),
        ]),
      ]),
      h("div", { key: "date-label", style: { margin: "2px 0 10px", fontWeight: 650 } }, formatDayLabel(dailyDate)),
      dailyLoading ? h("div", { key: "loading", className: "auth-loading" }, [h("span", { key: "dot", className: "dot loading" }), " Carregando o dia..."]) : null,
      dailyError ? h("div", { key: "error", className: "card section", style: { borderColor: "#ff6b75" } }, "Não foi possível carregar o desempenho diário: " + dailyError) : null,
      !dailyLoading && dailyData ? h(DailySummary, { key: "summary", summary: dailyData.summary || {} }) : null,
      !dailyLoading && dailyData && visible.length === 0 ? h("div", { key: "empty", className: "card section" }, "Nenhum colaborador encontrado para este filtro.") : null,
      !dailyLoading && dailyData ? visible.map(function (row: any) { return h(DailyPersonCard, { key: row.person, row: row }); }) : null,
    ]);
  }

  if (error) {
    return h("section", { className: "workspace" }, [
      h("div", { key: "hd", className: "workspace-head" }, h("div", null, h("h2", null, "Desempenho OP"))),
      h("div", { key: "m" }, modeTabs),
      h("div", { key: "err", className: "card section" }, "Não foi possível carregar: " + error),
    ]);
  }
  if (!data) {
    return h("section", { className: "workspace" }, [
      h("div", { key: "hd", className: "workspace-head" }, h("div", null, h("h2", null, "Desempenho OP"))),
      h("div", { key: "m" }, modeTabs),
      h("div", { key: "ld", className: "auth-loading" }, [h("span", { key: "d", className: "dot loading" }), " Carregando desempenho..."]),
    ]);
  }

  const roleSet: Record<string, boolean> = {};
  data.people.forEach(function (p: any) { roleSet[p.role] = true; });
  const roles = ["ALL"].concat(Object.keys(roleSet));
  const visiblePeople = roleFilter === "ALL" ? data.people : data.people.filter(function (p: any) { return p.role === roleFilter; });

  const unmappedBanner = data.unmapped_collaborators.length > 0
    ? h("div", { className: "card section", style: { marginBottom: 12, borderColor: "#f7c95c" } }, [
        h("b", { key: "b" }, "Colaboradores ativos no ClickUp sem cadastro no roster: "),
        data.unmapped_collaborators.map(function (u: any) { return u.username + " (" + u.tasks + ")"; }).join(", "),
      ])
    : null;

  const roleTabs = h("div", { className: "filter-tabs", style: { marginBottom: 12 } }, roles.map(function (role) {
    return h("button", {
      key: role,
      className: roleFilter === role ? "active" : "",
      onClick: function () { setRoleFilter(role); },
    }, role === "ALL" ? "Todos" : (ROLE_LABEL[role] || role));
  }));

  const heatmaps = visiblePeople.map(function (row: any) {
    return h(PersonHeatmap, { key: row.person, person: row.person, activity: data.heatmap[row.person] || {}, since: data.period.heatmap_since });
  });

  const cards = visiblePeople.length === 0
    ? h("div", { className: "card section" }, "Sem colaboradores para este filtro.")
    : visiblePeople.map(function (row: any) { return h(PersonCard, { key: row.person, row: row }); });

  return h("section", { className: "workspace" }, [
    h("div", { key: "hd", className: "workspace-head" }, h("div", null, [
      h("h2", { key: "t" }, "Desempenho OP"),
      h("p", { key: "sub", style: { color: "#8aa3c0", margin: "4px 0 0" } },
        "Visão por colaborador · janela de " + data.period.since + " até " + data.period.until + ". Diário de ajustes e TaskLog entram automaticamente conforme são preenchidos."),
    ])),
    h("div", { key: "m" }, modeTabs),
    unmappedBanner,
    roleTabs,
    h("h3", { key: "h1", style: { margin: "4px 0 8px" } }, "Atividade"),
    heatmaps,
    h("h3", { key: "h2", style: { margin: "16px 0 8px" } }, "Métricas"),
    cards,
  ]);
}
