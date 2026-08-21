"use client";

// Aba "Desempenho OP" - visao por colaborador: tasks concluidas, diario de ajustes,
// tasklog, tempo de entrega de criativo/trafego (novo x ajuste) e tempo de resposta do
// CS no WhatsApp, com um mapa de atividade diaria estilo GitHub. Dado sensivel de
// performance individual - fica atras da permissao "opsperf" (MGMT/AI por padrao).
//
// Escrito com React.createElement (em vez de JSX) de proposito: evita o auto-fechamento
// de tags do editor web do GitHub, que duplicava fechamentos ao digitar JSX direto.
import { createElement as h, useEffect, useMemo, useState } from "react";
import { api } from "../shared";

const MUTED = { color: "#8aa3c0" };
const ROLE_LABEL = { CS: "CS", DESIGN: "Design", GT: "Gestor de trafego", MGMT: "Gestao", AI: "IA" };

function formatHours(hours) {
  if (hours === null || hours === undefined) return "-";
  if (hours < 24) return hours.toFixed(1) + "h";
  return (hours / 24).toFixed(1) + "d";
}
function formatMinutes(min) {
  if (min === null || min === undefined) return "-";
  if (min < 60) return Math.round(min) + " min";
  return (min / 60).toFixed(1) + "h";
}

function buildHeatmapWeeks(activity, since) {
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
function levelColor(count) {
  if (count <= 0) return "rgba(255,255,255,.06)";
  if (count === 1) return "#0e4429";
  if (count <= 3) return "#006d32";
  if (count <= 6) return "#26a641";
  return "#39d353";
}
function currentStreak(activity) {
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

function PersonHeatmap(props) {
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
    h("div", { key: "hd", style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 } }, [
      h("b", { key: "n" }, person),
      h("small", { key: "s", style: MUTED }, total + " atividades nos ultimos 12 meses - streak atual: " + streak + (streak === 1 ? " dia" : " dias")),
    ]),
    h("div", { key: "grid", style: { display: "flex", gap: 3, overflowX: "auto", paddingBottom: 4 } }, weekCols),
  ]);
}

function statBlock(key, label, valueNode) {
  return h("div", { key: key }, [
    h("small", { key: "l", style: MUTED }, label),
    h("div", { key: "v", style: { fontSize: 20, fontWeight: 600 } }, valueNode),
  ]);
}

function PersonCard(props) {
  const row = props.row;
  const blocks = [
    statBlock("tc", "Tasks concluidas", String(row.tasks_completed)),
    statBlock("to", "Em aberto agora", [
      String(row.tasks_open),
      row.overdue_tasks > 0 ? h("span", { key: "od", style: { color: "#ff6b75", fontSize: 13, marginLeft: 6 } }, "(" + row.overdue_tasks + (row.overdue_tasks === 1 ? " atrasada)" : " atrasadas)")) : null,
    ]),
    statBlock("ot", "No prazo", row.on_time_rate === null ? "-" : row.on_time_rate + "%"),
  ];
  if (row.role === "DESIGN" || row.role === "GT") {
    blocks.push(statBlock("hn", "Entrega - criativo novo", [formatHours(row.avg_hours_novo), h("small", { key: "c", style: MUTED }, " (" + row.creatives_novo + ")")]));
    blocks.push(statBlock("ha", "Entrega - ajuste", [formatHours(row.avg_hours_ajuste), h("small", { key: "c", style: MUTED }, " (" + row.creatives_ajuste + ")")]));
  }
  if (row.role === "CS") {
    blocks.push(statBlock("cs", "Resposta media ao cliente", [formatMinutes(row.avg_cs_response_minutes), h("small", { key: "c", style: MUTED }, " (" + row.cs_replies + ")")]));
  }
  return h("div", { className: "card section", style: { marginBottom: 12 } }, [
    h("div", { key: "hd", style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } }, [
      h("b", { key: "n" }, row.person),
      h("span", { key: "r", className: "chip" }, ROLE_LABEL[row.role] || row.role),
    ]),
    h("div", { key: "stats", style: { display: "flex", flexWrap: "wrap", gap: 16, marginTop: 10 } }, blocks),
  ]);
}

export function OpsPerfCenter(props) {
  const token = props.token;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [roleFilter, setRoleFilter] = useState("ALL");

  useEffect(function () {
    let cancelled = false;
    api("opsperf", token)
      .then(function (payload) { if (!cancelled) setData(payload); })
      .catch(function (err) { if (!cancelled) setError(String((err && err.message) || err)); });
    return function () { cancelled = true; };
  }, [token]);

  if (error) {
    return h("section", { className: "workspace" }, [
      h("div", { key: "hd", className: "workspace-head" }, h("div", null, h("h2", null, "Desempenho OP"))),
      h("div", { key: "err", className: "card section" }, "Nao foi possivel carregar: " + error),
    ]);
  }
  if (!data) {
    return h("section", { className: "workspace" }, [
      h("div", { key: "hd", className: "workspace-head" }, h("div", null, h("h2", null, "Desempenho OP"))),
      h("div", { key: "ld", className: "auth-loading" }, [h("span", { key: "d", className: "dot loading" }), " Carregando desempenho..."]),
    ]);
  }

  const roleSet = {};
  data.people.forEach(function (p) { roleSet[p.role] = true; });
  const roles = ["ALL"].concat(Object.keys(roleSet));
  const visiblePeople = roleFilter === "ALL" ? data.people : data.people.filter(function (p) { return p.role === roleFilter; });

  const unmappedBanner = data.unmapped_collaborators.length > 0
    ? h("div", { className: "card section", style: { marginBottom: 12, borderColor: "#f7c95c" } }, [
        h("b", { key: "b" }, "Colaboradores ativos no ClickUp sem cadastro no roster: "),
        data.unmapped_collaborators.map(function (u) { return u.username + " (" + u.tasks + ")"; }).join(", "),
      ])
    : null;

  const roleTabs = h("div", { className: "filter-tabs", style: { marginBottom: 12 } }, roles.map(function (role) {
    return h("button", {
      key: role,
      className: roleFilter === role ? "active" : "",
      onClick: function () { setRoleFilter(role); },
    }, role === "ALL" ? "Todos" : (ROLE_LABEL[role] || role));
  }));

  const heatmaps = visiblePeople.map(function (row) {
    return h(PersonHeatmap, { key: row.person, person: row.person, activity: data.heatmap[row.person] || {}, since: data.period.heatmap_since });
  });

  const cards = visiblePeople.length === 0
    ? h("div", { className: "card section" }, "Sem colaboradores para este filtro.")
    : visiblePeople.map(function (row) { return h(PersonCard, { key: row.person, row: row }); });

  return h("section", { className: "workspace" }, [
    h("div", { key: "hd", className: "workspace-head" }, h("div", null, [
      h("h2", { key: "t" }, "Desempenho OP"),
      h("p", { key: "sub", style: { color: "#8aa3c0", margin: "4px 0 0" } },
        "Visao por colaborador - janela de " + data.period.since + " ate " + data.period.until + ". Diario de ajustes e tasklog entram aqui automaticamente assim que passarem a ser preenchidos - hoje ainda tem pouco ou nenhum registro."),
    ])),
    unmappedBanner,
    roleTabs,
    h("h3", { key: "h1", style: { margin: "4px 0 8px" } }, "Atividade"),
    heatmaps,
    h("h3", { key: "h2", style: { margin: "16px 0 8px" } }, "Metricas"),
    cards,
  ]);
}
