const M = window.MODE,
  S = {
    clientView: null,
    clientOverview: null,
    accountCache: null,
    accountPromise: null,
    historyCache: null,
    historyPromise: null,
    overviewPromise: null,
    hubSummaryCache: null,
    portalCache: null,
    materialsCache: null,
    approvalsCache: null,
    requestsCache: null,
    entityCache: {},
  };
const $ = (q, e = document) => e.querySelector(q),
  $$ = (q, e = document) => [...e.querySelectorAll(q)],
  E = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  V = (x) =>
    Array.isArray(x)
      ? x.join(", ")
      : typeof x === "object"
        ? JSON.stringify(x)
        : String(x ?? ""),
  F = (d) => (d ? new Date(d).toLocaleString("pt-BR") : "—");
async function A(p, o = {}) {
  let r = await fetch(p, {
      headers: { "content-type": "application/json", ...(o.headers || {}) },
      ...o,
    }),
    j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || "erro");
  return j;
}
function login() {
  document.getElementById("app").innerHTML =
    '<main class="auth-shell"><aside class="auth-aside"><div class="auth-aside-mark"><svg viewBox="0 0 276 390" role="img" aria-label="Leonardo Imobi" fill="none"><rect x="6.5" y="6.5" width="263" height="252" stroke="currentColor" stroke-width="13"></rect><rect x="0" y="252" width="13" height="138" fill="currentColor"></rect><polygon points="68,223 276,247 276,253 68,253" fill="currentColor"></polygon><polygon points="0,377 208,343 208,390 0,390" fill="currentColor"></polygon></svg></div><div class="auth-aside-word"><b>Leonardo Imobi</b><span>Growth Imobili&aacute;rio</span></div><p class="auth-aside-note">Briefings, produtos e personas em um s&oacute; lugar.</p></aside><section class="auth-card"><div class="auth-head"><span class="eyebrow">Briefing Hub</span><h1>' +
    (M === "STAFF" ? "Acesso interno" : "Portal do Cliente") +
    "</h1><p>" +
    (M === "STAFF"
      ? "Use o mesmo acesso do dashboard."
      : "Acesse seus produtos, personas e briefings para continuar.") +
    '</p></div><form id="lg">' +
    (M === "STAFF"
      ? '<label>E-mail<input name="email" type="email" placeholder="voce@empresa.com" autocomplete="username" required></label>'
      : '<label>Usu&aacute;rio<input name="username" type="text" placeholder="Seu usu&aacute;rio" autocomplete="username" required></label>') +
    '<label>Senha<input name="password" type="password" placeholder="Sua senha" autocomplete="current-password" required></label><button class="auth-submit">Entrar</button><div id="er" class="auth-error" aria-live="polite"></div></form></section></main>';
  document.getElementById("lg").onsubmit = async (e) => {
    e.preventDefault();
    let f = new FormData(document.getElementById("lg"));
    try {
      await A("/api/" + (M === "STAFF" ? "staff" : "client") + "/login", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(f)),
      });
      location.reload();
    } catch (x) {
      document.getElementById("er").textContent = x.message;
    }
  };
}
function shell() {
  document.getElementById("app").innerHTML =
    '<div class="shell bh-shell"><aside class="side-nav open"><div class="bh-side-brand"><div class="bh-side-logo">BH</div><div><b>Briefing Hub</b><small>Leonardo Imobi</small></div></div><div id="nav"></div><div class="bh-side-footer"><button id="out">Sair</button></div></aside><main class="main"><div class="bh-main-frame"><div id="view"></div></div></main></div>';
  document.getElementById("out").onclick = async () => {
    await A("/api/" + (M === "STAFF" ? "staff" : "client") + "/logout", {
      method: "POST",
    });
    location.reload();
  };
}
function modal(h) {
  let m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = '<div class="box">' + h + "</div>";
  document.body.append(m);
  return m;
}
function pill(x) {
  return '<span class="pill">' + E(x) + "</span>";
}
function text(b, title) {
  let g = {};
  for (let q of b.questions) (g[q.section_name] ??= []).push(q);
  let o = title + "\n\n";
  for (let s in g) {
    o += s.toUpperCase() + "\n";
    for (let q of g[s]) {
      let v = b.answers[q.question_key]?.value;
      if (V(v).trim()) o += q.label + ": " + V(v) + "\n";
    }
    o += "\n";
  }
  return o.trim();
}
async function hist(type, id) {
  let h = await A(
      "/api/" +
        (M === "STAFF" ? "staff" : "client") +
        "/history?type=" +
        type +
        "&id=" +
        id,
    ),
    m = modal(
      '<div class="row between"><h2>Histórico de versionamento</h2><button class="btn" id="close">Fechar</button></div><p class="muted">A última atualização é sempre a fonte oficial.</p><div class="history">' +
        h.history
          .map(
            (x) =>
              '<div class="hist"><b>' +
              E(x.label || x.question_key) +
              '</b><div class="muted">' +
              F(x.changed_at) +
              " · " +
              E(x.changed_by_name || x.changed_by_type) +
              "</div><div>" +
              E(V(x.old_value)) +
              " → <b>" +
              E(V(x.new_value)) +
              "</b></div></div>",
          )
          .join("") +
        "</div>",
    );
  $("#close", m).onclick = () => m.remove();
}
function qhelp(q) {
  let parts = "";
  if (q.help_what) parts += "<b>O que responder</b>" + E(q.help_what);
  if (q.help_why) parts += "<b>Por que perguntamos</b>" + E(q.help_why);
  if (q.example_text) parts += "<b>Exemplo</b>" + E(q.example_text);
  if (q.common_mistake) parts += "<b>Evite</b>" + E(q.common_mistake);
  return parts
    ? '<span class="qhelp" tabindex="0">?<span class="tip">' +
        parts +
        "</span></span>"
    : "";
}
function opt(q, v) {
  let a = Array.isArray(q.options) ? q.options : [];
  return a
    .map(
      (x) =>
        '<option value="' +
        E(x) +
        '" ' +
        (Array.isArray(v)
          ? v.includes(x)
          : String(v ?? "") === String(x)
            ? "selected"
            : "") +
        ">" +
        E(x) +
        "</option>",
    )
    .join("");
}
function inputFor(q, v) {
  v = v ?? "";
  if (q.input_type === "TEXTAREA")
    return (
      '<textarea data-k="' + q.question_key + '">' + E(V(v)) + "</textarea>"
    );
  if (q.input_type === "SELECT")
    return (
      '<select data-k="' +
      q.question_key +
      '"><option value="">Selecione…</option>' +
      opt(q, v) +
      "</select>"
    );
  if (q.input_type === "MULTISELECT")
    return (
      '<select multiple data-k="' +
      q.question_key +
      '">' +
      opt(q, v) +
      "</select>"
    );
  if (q.input_type === "BOOLEAN")
    return (
      '<select data-k="' +
      q.question_key +
      '"><option value="">Selecione…</option><option ' +
      (String(v) === "Sim" ? "selected" : "") +
      ">Sim</option><option " +
      (String(v) === "Não" ? "selected" : "") +
      ">Não</option></select>"
    );
  let ty =
      q.input_type === "NUMBER" || q.input_type === "CURRENCY"
        ? "number"
        : q.input_type === "DATE"
          ? "date"
          : q.input_type === "URL"
            ? "url"
            : "text",
    step = q.input_type === "CURRENCY" ? ' step="0.01"' : "";
  return (
    '<input type="' +
    ty +
    '"' +
    step +
    ' data-k="' +
    q.question_key +
    '" value="' +
    E(V(v)) +
    '">'
  );
}
function getVal(el) {
  if (el.multiple) return [...el.selectedOptions].map((o) => o.value);
  return el.value;
}
function condOK(q, vals) {
  let c = q.show_when;
  if (!c) return (true, (v = vals[c.key]));
  if (c.notEmpty) return V(v).trim() !== "";
  if (c.in) return c.in.includes(v);
  if (c.containsAny) {
    let a = Array.isArray(v) ? v : [v];
    return a.some((x) => c.containsAny.includes(x));
  }
  return true;
}
function applyConds(m, b) {
  let vals = {};
  for (let q of b.questions) {
    let el = $('[data-k="' + q.question_key + '"]', m);
    vals[q.question_key] = el ? getVal(el) : b.answers[q.question_key]?.value;
  }
  for (let q of b.questions) {
    let f = $('[data-qk="' + q.question_key + '"]', m);
    if (f) f.hidden = !condOK(q, vals);
  }
}
async function open(type, id) {
  let k = M === "STAFF" ? "staff" : "client",
    b = await A("/api/" + k + "/entity?type=" + type + "&id=" + id),
    g = {};
  for (let q of b.questions) (g[q.section_name] ??= []).push(q);
  let linkHtml =
    type === "PRODUCT" && b.links?.length
      ? '<section class="section"><h3>Personas vinculadas</h3><div class="grid cards">' +
        b.links
          .map(
            (p) =>
              '<div class="card"><div class="row between"><b>' +
              E(p.name) +
              "</b>" +
              pill(p.status) +
              '</div><button class="btn" data-ctx="' +
              p.id +
              '" style="margin-top:8px">Encaixe Produto ÃÂÃÂ Persona</button></div>',
          )
          .join("") +
        "</div></section>"
      : "";
  let m = modal(
    '<div class="row between"><div><h2>' +
      E(b.entity.name) +
      "</h2><div>" +
      pill(b.entity.status) +
      ' · <span class="muted">fonte oficial atual</span></div></div><button class="btn" id="close">Fechar</button></div><div class="row" style="margin-top:12px"><button class="btn" id="history">Histórico</button>' +
      (M === "STAFF"
        ? '<button class="btn" id="copy">Copiar briefing</button><button class="btn" id="pdf">PDF</button>' +
          (type === "PRODUCT"
            ? '<button class="btn primary" id="exec">Briefing p/ Execução</button>'
            : "")
        : "") +
      "</div>" +
      Object.entries(g)
        .map(
          ([s, qs]) =>
            '<section class="section"><h3>' +
            E(s) +
            '</h3><div class="grid form">' +
            qs
              .map((q) => {
                let v = b.answers[q.question_key]?.value;
                return (
                  '<div class="field" data-qk="' +
                  q.question_key +
                  '"><div class="qline"><label>' +
                  E(q.label) +
                  (q.required || q.required_when ? " *" : "") +
                  "</label>" +
                  qhelp(q) +
                  "</div>" +
                  (q.visibility_hint === "INTERNAL_STRATEGY"
                    ? '<div class="internalhint">🔒 Informação estratégica. Não deve ser copiada literalmente para anúncio.</div>'
                    : "") +
                  inputFor(q, v) +
                  (q.allow_unknown
                    ? '<button type="button" class="unknown" data-u="' +
                      q.question_key +
                      '">Não sei / quero ajuda da equipe</button>'
                    : "") +
                  '<small class="muted" data-s="' +
                  q.question_key +
                  '"></small></div>'
                );
              })
              .join("") +
            "</div></section>",
        )
        .join("") +
      linkHtml,
  );
  $("#close", m).onclick = () => m.remove();
  $("#history", m).onclick = () => hist(type, id);
  $$("[data-ctx]", m).forEach((bt) => {
    let p = b.links.find((x) => x.id === bt.dataset.ctx);
    bt.onclick = () => contextView(id, p);
  });
  if (M === "STAFF") {
    $("#copy", m).onclick = () =>
      navigator.clipboard.writeText(text(b, b.entity.name));
    $("#pdf", m).onclick = () => {
      location.href = "/api/staff/pdf?type=" + type + "&id=" + id;
    };
    if (type === "PRODUCT")
      $("#exec", m).onclick = async () => {
        let o = "BRIEFING PARA EXECUÃÂÃÂÃÂÃÂO\n\n" + text(b, "PRODUTO");
        for (let l of b.links) {
          let p = await A("/api/staff/entity?type=PERSONA&id=" + l.id);
          o += "\n\n" + text(p, "PERSONA — " + p.entity.name);
        }
        await navigator.clipboard.writeText(o);
        alert("Briefing para Execução copiado");
      };
  }
  let ts = {};
  $$("[data-u]", m).forEach(
    (bt) =>
      (bt.onclick = () => {
        let el = $('[data-k="' + bt.dataset.u + '"]', m);
        if (!el) return;
        if (el.multiple) {
          [...el.options].forEach((o) => (o.selected = false));
        } else el.value = "Não sei / quero ajuda da equipe";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }),
  );
  $$("[data-k]", m).forEach((el) => {
    let fire = () => {
      clearTimeout(ts[el.dataset.k]);
      ts[el.dataset.k] = setTimeout(async () => {
        let s = $('[data-s="' + el.dataset.k + '"]', m);
        s.textContent = "Salvando…";
        try {
          let z = await A("/api/" + k + "/answer", {
            method: "PUT",
            body: JSON.stringify({
              type,
              id,
              key: el.dataset.k,
              value: getVal(el),
            }),
          });
          s.textContent = "Salvo · " + z.status;
          b.answers[el.dataset.k] = { value: getVal(el) };
          applyConds(m, b);
        } catch (x) {
          s.textContent = "Erro ao salvar";
        }
      }, 900);
    };
    el.oninput = fire;
    el.onchange = fire;
  });
  applyConds(m, b);
}
function buildNav(items, fn) {
  document.getElementById("nav").innerHTML = items
    .map(
      (x, i) =>
        '<button class="' +
        (i ? "" : "on") +
        '" data-v="' +
        x[0] +
        '">' +
        x[1] +
        "</button>",
    )
    .join("");
  $$("#nav button").forEach(
    (b) =>
      (b.onclick = () => {
        $$("#nav button").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        fn(b.dataset.v);
      }),
  );
}
async function create(ep, cid, label) {
  let m = modal(
    '<h2>Novo</h2><form id="cf" class="grid"><label>' +
      label +
      '</label><input name="name" required><div class="row"><button class="btn primary">Criar</button><button type="button" class="btn" id="cc">Cancelar</button></div></form>',
  );
  $("#cc", m).onclick = () => m.remove();
  $("#cf", m).onsubmit = async (e) => {
    e.preventDefault();
    let name = new FormData(e.target).get("name");
    await A("/api/" + (M === "STAFF" ? "staff" : "client") + "/" + ep, {
      method: "POST",
      body: JSON.stringify({ name, client_id: cid }),
    });
    m.remove();
    M === "STAFF"
      ? client(cid)
      : clientView(ep === "products" ? "products" : "personas");
  };
}
async function link(product, personas) {
  let m = modal(
    '<h2>Reutilizar Persona</h2><div class="grid">' +
      personas
        .map(
          (p) =>
            '<button class="btn" data-p="' +
            p.id +
            '">' +
            E(p.name) +
            " · " +
            E(p.status) +
            "</button>",
        )
        .join("") +
      "</div>",
  );
  $$("[data-p]", m).forEach(
    (b) =>
      (b.onclick = async () => {
        await A(
          "/api/" + (M === "STAFF" ? "staff" : "client") + "/link-persona",
          {
            method: "POST",
            body: JSON.stringify({
              product_id: product,
              persona_id: b.dataset.p,
            }),
          },
        );
        m.remove();
        M === "STAFF" ? client(S.cid) : clientView("products");
      }),
  );
}
async function accountView(cid) {
  let k = M === "STAFF" ? "staff" : "client",
    q = cid ? "?id=" + cid : "",
    b =
      (!cid && M === "CLIENT" && S.accountCache) ||
      (await ((!cid && M === "CLIENT" && S.accountPromise) ||
        A("/api/" + k + "/account" + q))),
    g = {};
  if (!cid && M === "CLIENT") S.accountCache = b;
  for (let x of b.questions) (g[x.section_name] ??= []).push(x);
  let m =
      M === "STAFF"
        ? modal(
            '<div class="row between"><h2>Marca e Mercado · ' +
              E(b.client.name) +
              '</h2><button class="btn" id="aclose">Fechar</button></div><div id="accountfields"></div>',
          )
        : null,
    root = M === "STAFF" ? $("#accountfields", m) : view;
  root.innerHTML =
    (M === "CLIENT"
      ? '<div><h2>Marca e Mercado</h2><p class="muted">Informações reaproveitáveis em todos os seus produtos.</p></div>'
      : "") +
    Object.entries(g)
      .map(
        ([s, qs]) =>
          '<section class="section"><h3>' +
          E(s) +
          '</h3><div class="grid form">' +
          qs
            .map(
              (x) =>
                '<div class="field"><div class="qline"><label>' +
                E(x.label) +
                (x.required ? " *" : "") +
                "</label>" +
                qhelp(x) +
                "</div>" +
                inputFor(x, b.answers[x.question_key]?.value) +
                '<small class="muted" data-as="' +
                x.question_key +
                '"></small></div>',
            )
            .join("") +
          "</div></section>",
      )
      .join("");
  if (M === "STAFF") $("#aclose", m).onclick = () => m.remove();
  let ts = {};
  $$("[data-k]", root).forEach((el) => {
    let fire = () => {
      clearTimeout(ts[el.dataset.k]);
      ts[el.dataset.k] = setTimeout(async () => {
        let s = $('[data-as="' + el.dataset.k + '"]', root);
        s.textContent = "Salvando…";
        try {
          await A("/api/" + k + "/account", {
            method: "PUT",
            body: JSON.stringify({
              client_id: cid,
              key: el.dataset.k,
              value: getVal(el),
            }),
          });
          s.textContent = "Salvo";
        } catch (e) {
          s.textContent = "Erro ao salvar";
        }
      }, 900);
    };
    el.oninput = fire;
    el.onchange = fire;
  });
}
async function contextView(productId, p) {
  let k = M === "STAFF" ? "staff" : "client",
    r = await A(
      "/api/" + k + "/context?product_id=" + productId + "&persona_id=" + p.id,
    ),
    x = r.x || {},
    fields = [
      [
        "fit_reason",
        "Por que este produto faz sentido para esta Persona?",
        "Explique o encaixe específico entre público e produto.",
      ],
      [
        "transition_benefit",
        "O que essa pessoa ganha ao escolher esta localização/produto?",
        "Pense na mudanÃÂÃÂ§a de rotina, patrimônio ou uso.",
      ],
      [
        "strongest_angle",
        "Qual é o ângulo mais forte para essa combinação?",
        "Ex.: moradia, investimento, localização, condição, exclusividade.",
      ],
      [
        "specific_objection",
        "Existe alguma objeção específica dessa Persona para este produto?",
        "Opcional; não é requisito para concluir o briefing.",
      ],
    ];
  let m = modal(
    '<div class="row between"><div><h2>' +
      E(p.name) +
      '</h2><p class="muted">Contexto Produto ÃÂÃÂ Persona</p></div><button class="btn" id="xclose">Fechar</button></div><div class="grid">' +
      fields
        .map(
          (f) =>
            '<div class="field"><label>' +
            E(f[1]) +
            '</label><small class="muted">' +
            E(f[2]) +
            '</small><textarea data-x="' +
            f[0] +
            '">' +
            E(x[f[0]] || "") +
            '</textarea><small class="muted" data-xs="' +
            f[0] +
            '"></small></div>',
        )
        .join("") +
      "</div>",
  );
  $("#xclose", m).onclick = () => m.remove();
  let ts = {};
  $$("[data-x]", m).forEach(
    (el) =>
      (el.oninput = () => {
        clearTimeout(ts[el.dataset.x]);
        ts[el.dataset.x] = setTimeout(async () => {
          let s = $('[data-xs="' + el.dataset.x + '"]', m);
          s.textContent = "Salvando…";
          try {
            await A("/api/" + k + "/context", {
              method: "PUT",
              body: JSON.stringify({
                product_id: productId,
                persona_id: p.id,
                field: el.dataset.x,
                value: el.value,
              }),
            });
            s.textContent = "Salvo";
          } catch (e) {
            s.textContent = "Erro";
          }
        }, 900);
      }),
  );
}

function bytesLabel(n) {
  n = Number(n || 0);
  return n < 1024
    ? n + " B"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " KB"
      : (n / 1048576).toFixed(1) + " MB";
}
async function fileB64(f) {
  return new Promise(function (res, rej) {
    let r = new FileReader();
    r.onload = function () {
      res(String(r.result).split(",")[1]);
    };
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}
function requestModal(o) {
  let m = modal(
    '<h2>Nova solicitação</h2><form id="reqf" class="grid form"><label>Tipo<select name="request_type"><option value="CRIATIVO">Novo criativo</option><option value="CAMPANHA">Campanha / anúncio</option><option value="ALTERACAO">Alteração</option><option value="NOVO_PRODUTO">Novo produto</option><option value="ATUALIZACAO">Atualização de informação</option><option value="ENVIO_MATERIAL">Envio de material</option><option value="OUTRO">Outro</option></select></label><label>Produto relacionado<select name="product_id"><option value="">Geral / não se aplica</option>' +
      o.products
        .map(function (p) {
          return '<option value="' + p.id + '">' + E(p.name) + "</option>";
        })
        .join("") +
      '</select></label><label>Explique o pedido<textarea name="details" rows="6" required></textarea></label><button class="btn primary">Enviar solicitação</button></form>',
  );
  $("#reqf", m).onsubmit = async function (e) {
    e.preventDefault();
    let f = new FormData(e.target);
    await A("/api/client/requests", {
      method: "POST",
      body: JSON.stringify({
        request_type: f.get("request_type"),
        product_id: f.get("product_id"),
        details: f.get("details"),
      }),
    });
    S.requestsCache = null;
    m.remove();
    clientShell("requests");
  };
}
function humanStatus(x) {
  return x === "COMPLETE"
    ? "Concluído"
    : x === "IN_PROGRESS"
      ? "Em andamento"
      : "Não iniciado";
}
function greetingV2() {
  let h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}
function displayPercentV2(p) {
  return p?.submitted_at ? 100 : Number(p?.percent || 0);
}
function pbarHtml(p) {
  p = Math.max(0, Math.min(100, Number(p) || 0));
  return (
    '<div class="pbar" aria-label="' +
    p +
    '% concluído"><span style="width:' +
    p +
    '%"></span></div>'
  );
}
function firstName() {
  let n = String(S.me?.display_name || S.me?.username || "").trim();
  return n ? n.split(/\s+/)[0] : "Olá";
}
function invalidateClientCache() {
  S.clientOverview = null;
  S.overviewPromise = null;
  S.accountCache = null;
  S.accountPromise = null;
  S.historyCache = null;
  S.historyPromise = null;
}
function warmClientData(o) {
  if (!S.accountCache && !S.accountPromise)
    S.accountPromise = A("/api/client/account")
      .then((x) => (S.accountCache = x))
      .catch(() => null)
      .finally(() => (S.accountPromise = null));
  if (!S.historyCache && !S.historyPromise) {
    let entities = [
      ...o.products.map((x) => ({ ...x, _t: "PRODUCT" })),
      ...o.personas.map((x) => ({ ...x, _t: "PERSONA" })),
    ];
    S.historyPromise = Promise.all(
      entities.map(async (p) => {
        let h = await A("/api/client/history?type=" + p._t + "&id=" + p.id);
        return h.history.map((x) => ({ ...x, entity_name: p.name }));
      }),
    )
      .then((x) => (S.historyCache = x))
      .catch(() => null)
      .finally(() => (S.historyPromise = null));
  }
}
function clientShell(v) {
  S.clientView = v;
  if (!$(".bh-shell")) shell();
  if (!$("#nav button")) {
    let b = $(".bh-side-brand b"),
      s = $(".bh-side-brand small"),
      l = $(".bh-side-logo");
    if (b) b.textContent = "Briefing Hub";
    if (s) s.textContent = (S.me && S.me.client_name) || "Área do cliente";
    if (l) l.textContent = "BH";
    buildNav(
      [
        ["home", "Início"],
        ["products", "Produtos"],
        ["personas", "Personas"],
        ["materials", "Materiais"],
        ["drive", "Drive"],
        ["integrations", "Integrações"],
        ["history", "Histórico"],
      ],
      clientShell,
    );
  }
  $$("#nav button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
  let root = $("#view");
  if (root)
    root.innerHTML =
      '<div class="nav-skeleton" aria-label="Carregando a seção"><span></span><span></span><span></span></div>';
  clientView(v);
}
function progressMeta(p) {
  if (p?.submitted_at) return "Briefing recebido";
  let txt = (p?.done || 0) + " de " + (p?.total || 0) + " perguntas";
  if (p?.current_section) txt += " · " + p.current_section;
  return txt;
}
function choosePending(o) {
  let all = [
    ...o.products.map((x) => ({
      kind: "PRODUCT",
      entity: x,
      progress: x.progress,
    })),
    ...o.personas.map((x) => ({
      kind: "PERSONA",
      entity: x,
      progress: x.progress,
    })),
  ];
  all = all.filter((x) => !x.progress?.submitted_at);
  all.sort((a, b) =>
    String(b.progress?.updated_at || b.entity.updated_at || "").localeCompare(
      String(a.progress?.updated_at || a.entity.updated_at || ""),
    ),
  );
  return all[0] || null;
}
async function clientView(v) {
  let view = document.getElementById("view");
  if (v === "account") {
    window.view = view;
    return accountView(null);
  }
  let o = S.clientOverview;
  if (!o) {
    S.overviewPromise =
      S.overviewPromise ||
      A("/api/client/overview")
        .then((x) => (S.clientOverview = x))
        .finally(() => (S.overviewPromise = null));
    o = await S.overviewPromise;
  }
  warmClientData(o);
  if (S.clientView !== v || view !== document.getElementById("view")) return;
  if (v === "home") {
    let pending = choosePending(o),
      name = firstName(),
      cont = pending
        ? '<div class="card continue-card"><div class="continue-grid"><div><div class="v2-eyebrow">Continue de onde parou</div><h2>' +
          E(pending.entity.name) +
          '</h2><div class="continue-meta"><span>' +
          (pending.kind === "PRODUCT" ? "Produto" : "Persona") +
          "</span><span>•</span><span>" +
          E(
            pending.progress?.fill_mode === "COMPLETE"
              ? "Modo completo"
              : "Modo rápido",
          ) +
          "</span>" +
          (pending.progress?.current_section
            ? "<span>•</span><span>Você parou em " +
              E(pending.progress.current_section) +
              "</span>"
            : "") +
          "</div>" +
          pbarHtml(pending.progress?.percent) +
          '<div class="pbar-label"><span>' +
          E(progressMeta(pending.progress)) +
          "</span><b>" +
          Number(pending.progress?.percent || 0) +
          '%</b></div></div><button class="btn primary" id="continueMain">' +
          (pending.progress?.percent >= 100
            ? "Revisar e finalizar"
            : "Continuar de onde parei") +
          "</button></div></div>"
        : '<div class="card continue-card"><div class="continue-grid"><div><div class="v2-eyebrow">Tudo em dia</div><h2>Seus briefings estão organizados.</h2><p class="muted">Você pode revisar um produto ou criar um novo projeto quando quiser.</p></div><button class="btn primary" id="newMain">+ Novo produto</button></div></div>';
    view.innerHTML =
      '<div class="bh-client-home v2-fade"><header class="bh-welcome"><div><div class="eyebrow">Meus Projetos</div><h1>' +
      greetingV2() +
      ", " +
      E(name) +
      ".</h1><p>" +
      (pending
        ? "Você tem um briefing para continuar."
        : "Não há briefing pendente agora.") +
      "</p></div></header>" +
      cont +
      '<div class="home-shortcuts"><button class="shortcut" data-go="products"><b>Meus Produtos</b><span>' +
      o.products.length +
      ' cadastrados</span></button><button class="shortcut" data-go="personas"><b>Minhas Personas</b><span>' +
      o.personas.length +
      ' cadastradas</span></button><button class="shortcut" data-go="materials"><b>Materiais</b><span>Fotos, vídeos e arquivos</span></button><button class="shortcut" data-go="drive"><b>Drive</b><span>Abrir sua pasta</span></button></div></div>';
    $$("[data-go]").forEach(
      (b) => (b.onclick = () => clientShell(b.dataset.go)),
    );
    if (pending)
      $("#continueMain").onclick = () =>
        briefingMode(pending.kind, pending.entity.id, {
          review: Number(pending.progress?.percent || 0) >= 100,
        });
    else $("#newMain").onclick = () => newEntityClient("PRODUCT");
    warmClientData(o);
    return;
  }
  if (v === "products") {
    view.innerHTML =
      '<div class="row between"><div><div class="v2-eyebrow">Meus Projetos</div><h2>Produtos</h2><p class="muted">Produto é o que estamos vendendo. Vincule uma Persona para definir para quem estamos vendendo.</p></div><button class="btn primary" id="btnNewProduct">+ Novo produto</button></div>' +
      (o.products.length
        ? '<div class="project-grid">' +
          o.products
            .map(
              (p) =>
                '<article class="project-card"><div class="project-card-head"><div><h3>' +
                E(p.name) +
                '</h3><div class="sub">' +
                (p.personas?.length
                  ? p.personas.length +
                    " " +
                    (p.personas.length === 1
                      ? "persona vinculada"
                      : "personas vinculadas") +
                    " · atualizado " +
                    F(p.updated_at)
                  : "Nenhuma persona vinculada") +
                '</div></div><span class="pill ' +
                (p.progress?.submitted_at
                  ? "status-ok"
                  : p.progress?.percent
                    ? "status-warn"
                    : "status-new") +
                '">' +
                (p.progress?.submitted_at
                  ? "Enviado"
                  : p.progress?.percent
                    ? "Em andamento"
                    : humanStatus(p.status)) +
                "</span></div>" +
                pbarHtml(displayPercentV2(p.progress)) +
                '<div class="pbar-label"><span>' +
                E(progressMeta(p.progress)) +
                "</span><b>" +
                displayPercentV2(p.progress) +
                '%</b></div><div class="project-actions"><button class="btn primary" data-open-product="' +
                p.id +
                '">' +
                (p.progress?.submitted_at
                  ? "Ver briefing"
                  : p.progress?.percent
                    ? "Continuar briefing"
                    : "Começar briefing") +
                '</button><button class="btn" data-personas-for="' +
                p.id +
                '">Personas</button><a class="btn pdf-action" href="/api/client/pdf?type=PRODUCT&id=' +
                p.id +
                '" download>↓ PDF</a></div></article>',
            )
            .join("") +
          "</div>"
        : '<div class="empty-state">Você ainda não cadastrou nenhum produto.</div>');
    $("#btnNewProduct").onclick = () => newEntityClient("PRODUCT");
    $$("[data-open-product]").forEach((b) => {
      let p = o.products.find((x) => x.id === b.dataset.openProduct);
      b.onclick = () =>
        briefingMode("PRODUCT", b.dataset.openProduct, {
          summary: !!p?.progress?.submitted_at,
        });
    });
    $$("[data-personas-for]").forEach(
      (b) => (b.onclick = () => personaChooser(b.dataset.personasFor, o)),
    );
    return;
  }
  if (v === "personas") {
    view.innerHTML =
      '<div class="row between"><div><div class="v2-eyebrow">Públicos estratégicos</div><h2>Personas</h2><p class="muted">Persona é para quem estamos vendendo. Uma mesma Persona pode ser reutilizada em vários produtos.</p></div><button class="btn primary" id="btnNewPersona">+ Nova persona</button></div>' +
      (o.personas.length
        ? '<div class="project-grid">' +
          o.personas
            .map(
              (p) =>
                '<article class="project-card"><div class="project-card-head"><div><h3>' +
                E(p.name) +
                '</h3><div class="sub">' +
                (p.intent ? E(V(p.intent)) + " · " : "") +
                (Number(p.product_count || 0) === 1
                  ? "usada em 1 produto"
                  : "usada em " + Number(p.product_count || 0) + " produtos") +
                '</div></div><span class="pill ' +
                (p.progress?.submitted_at
                  ? "status-ok"
                  : p.progress?.percent
                    ? "status-warn"
                    : "status-new") +
                '">' +
                (p.progress?.submitted_at
                  ? "Enviada"
                  : p.progress?.percent
                    ? "Em andamento"
                    : humanStatus(p.status)) +
                "</span></div>" +
                pbarHtml(p.progress?.percent) +
                '<div class="pbar-label"><span>' +
                E(progressMeta(p.progress)) +
                "</span><b>" +
                Number(p.progress?.percent || 0) +
                '%</b></div><div class="project-actions"><button class="btn primary" data-open-persona="' +
                p.id +
                '">' +
                (p.progress?.submitted_at
                  ? "Ver persona"
                  : p.progress?.percent
                    ? "Continuar"
                    : "Preencher") +
                '</button><button class="btn" data-dup-persona="' +
                p.id +
                '">Duplicar e adaptar</button></div></article>',
            )
            .join("") +
          "</div>"
        : '<div class="empty-state">Você ainda não cadastrou nenhuma Persona.</div>');
    $("#btnNewPersona").onclick = () => newEntityClient("PERSONA");
    $$("[data-open-persona]").forEach((b) => {
      let p = o.personas.find((x) => x.id === b.dataset.openPersona);
      b.onclick = () =>
        briefingMode("PERSONA", b.dataset.openPersona, {
          summary: !!p?.progress?.submitted_at,
        });
    });
    $$("[data-dup-persona]").forEach(
      (b) =>
        (b.onclick = () => duplicatePersonaClient(b.dataset.dupPersona, null)),
    );
    return;
  }
  if (v === "materials") {
    let x = S.materialsCache || (await A("/api/client/materials"));
    S.materialsCache = x;
    if (S.clientView !== v) return;
    let err =
        x.ready === false
          ? '<div class="card"><b>Drive ainda não conectado</b><p class="muted">' +
            E(
              x.error ||
                "A integração com a pasta oficial ainda está sendo finalizada.",
            ) +
            "</p></div>"
          : "",
      items = (x.files || [])
        .map(function (f) {
          let url = f.web_url || f.url || "",
            title = E(f.file_name || f.name || "Arquivo"),
            meta = [
              f.path || f.scope_name || "",
              f.size_bytes ? bytesLabel(f.size_bytes) : "",
              f.created_at || f.modified_at
                ? F(f.created_at || f.modified_at)
                : "",
            ]
              .filter(Boolean)
              .map(E)
              .join(" · ");
          return (
            '<div class="card"><div class="row between"><div><b>' +
            title +
            '</b><div class="muted">' +
            meta +
            "</div></div>" +
            (url
              ? '<a class="btn" href="' +
                E(url) +
                '" target="_blank" rel="noopener">Abrir ↗</a>'
              : "") +
            "</div></div>"
          );
        })
        .join("");
    view.innerHTML =
      '<div class="row between"><div><div class="v2-eyebrow">Google Drive · sincronizado</div><h2>Materiais</h2><p class="muted">Tudo o que está na sua pasta oficial aparece aqui. Arquivos grandes são enviados em blocos diretamente para o Drive — o Briefing Hub não armazena uma cópia.</p></div>' +
      (x.folder_url
        ? '<a class="btn" href="' +
          E(x.folder_url) +
          '" target="_blank" rel="noopener">Abrir pasta ↗</a>'
        : "") +
      "</div>" +
      err +
      '<div class="card grid form"><label>Categoria<select id="mcat"><option value="FOTOS_VIDEOS">Fotos e vídeos</option><option value="IDENTIDADE">Logo e identidade</option><option value="PLANTAS">Plantas</option><option value="COMERCIAL">Materiais comerciais</option><option value="APRESENTACOES">PDFs e apresentações</option><option value="OUTROS">Outros</option></select></label><label>Produto<select id="mprod"><option value="">Geral do cliente</option>' +
      o.products
        .map(function (p) {
          return '<option value="' + p.id + '">' + E(p.name) + "</option>";
        })
        .join("") +
      '</select></label><label class="btn primary"' +
      (x.ready === false ? ' style="opacity:.55;pointer-events:none"' : "") +
      '>Selecionar arquivos<input id="mfile" type="file" multiple hidden ' +
      (x.ready === false ? "disabled" : "") +
      '></label><small id="mstatus" class="muted"></small><div id="mprogress" style="display:none;grid-column:1/-1;padding:14px;border:1px solid rgba(148,163,184,.25);border-radius:14px;background:rgba(15,23,42,.35);gap:8px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><b id="mprogresslabel">Preparando upload</b><b id="mprogresspct">0%</b></div><div style="height:10px;border-radius:999px;background:rgba(148,163,184,.2);overflow:hidden"><div id="mprogressbar" style="width:0%;height:100%;border-radius:999px;background:linear-gradient(90deg,#22c55e,#14b8a6);transition:width .18s ease"></div></div><div id="mprogressmeta" class="muted">Calculando tamanho…</div></div></div><div class="grid cards" style="margin-top:14px">' +
      (items ||
        '<div class="empty-state">Nenhum material encontrado nessa pasta.</div>') +
      "</div>";
    let inp = $("#mfile");
    if (inp)
      inp.onchange = async function (e) {
        let fs = [...e.target.files],
          st = $("#mstatus"),
          pg = $("#mprogress"),
          pl = $("#mprogresslabel"),
          pp = $("#mprogresspct"),
          pb = $("#mprogressbar"),
          pm = $("#mprogressmeta"),
          fmt = (n) => bytesLabel(n),
          chunk = 5 * 1024 * 1024,
          totalBytes = fs.reduce((n, f) => n + f.size, 0),
          completed = 0;
        function paint(bytes, label, meta, final) {
          let pct = totalBytes ? Math.round((bytes * 100) / totalBytes) : 0;
          if (!final) pct = Math.min(99, pct);
          pp.textContent = pct + "%";
          pb.style.width = pct + "%";
          pl.textContent = label;
          pm.textContent = meta;
        }
        try {
          if (!fs.length) return;
          if (fs.some((f) => !f.size))
            throw new Error("Não é possível enviar arquivo vazio.");
          inp.disabled = true;
          st.textContent = "";
          pg.style.display = "grid";
          for (let i = 0; i < fs.length; i++) {
            let f = fs[i],
              prefix =
                fs.length > 1
                  ? "Arquivo " + (i + 1) + " de " + fs.length + " · "
                  : "",
              init = await A("/api/client/materials/upload-start", {
                method: "POST",
                body: JSON.stringify({
                  category: $("#mcat").value,
                  product_id: $("#mprod").value || "",
                  file_name: f.name,
                  content_type: f.type || "application/octet-stream",
                  size_bytes: f.size,
                }),
              }),
              sent = 0,
              last = null;
            paint(
              completed,
              prefix + f.name,
              fmt(completed) + " de " + fmt(totalBytes) + " enviados",
              false,
            );
            while (sent < f.size) {
              let end = Math.min(f.size, sent + chunk) - 1,
                part = f.slice(sent, end + 1),
                attempt = 0;
              while (attempt < 3) {
                attempt++;
                try {
                  last = await new Promise(function (resolve, reject) {
                    let q = new XMLHttpRequest(),
                      url =
                        "/api/client/materials/upload-chunk?upload_id=" +
                        encodeURIComponent(init.upload_id) +
                        "&start=" +
                        sent +
                        "&end=" +
                        end +
                        "&total=" +
                        f.size;
                    q.open("POST", url);
                    q.timeout = 600000;
                    q.setRequestHeader(
                      "content-type",
                      f.type || "application/octet-stream",
                    );
                    q.upload.onprogress = function (ev) {
                      if (!ev.lengthComputable) return;
                      let current = completed + sent + ev.loaded,
                        detail =
                          fmt(current) +
                          " de " +
                          fmt(totalBytes) +
                          " enviados · " +
                          fmt(sent + ev.loaded) +
                          " de " +
                          fmt(f.size) +
                          " neste arquivo";
                      paint(current, prefix + f.name, detail, false);
                    };
                    q.onload = function () {
                      let d = {};
                      try {
                        d = JSON.parse(q.responseText || "{}");
                      } catch {}
                      if (q.status >= 200 && q.status < 300) resolve(d);
                      else
                        reject(
                          new Error(
                            d.error ||
                              "Falha no upload para o Drive (" + q.status + ")",
                          ),
                        );
                    };
                    q.onerror = function () {
                      reject(new Error("Falha de conexão durante o upload"));
                    };
                    q.ontimeout = function () {
                      reject(new Error("O envio demorou demais neste bloco"));
                    };
                    q.send(part);
                  });
                  break;
                } catch (er) {
                  if (attempt >= 3) throw er;
                  paint(
                    completed + sent,
                    prefix + f.name + " · reconectando",
                    fmt(completed + sent) +
                      " de " +
                      fmt(totalBytes) +
                      " enviados · tentativa " +
                      (attempt + 1) +
                      " de 3",
                    false,
                  );
                  await new Promise((ok) => setTimeout(ok, 900 * attempt));
                }
              }
              sent = end + 1;
              paint(
                completed + sent,
                prefix + f.name,
                fmt(completed + sent) +
                  " de " +
                  fmt(totalBytes) +
                  " enviados · " +
                  fmt(sent) +
                  " de " +
                  fmt(f.size) +
                  " neste arquivo",
                false,
              );
            }
            if (!last || !last.done)
              throw new Error(
                "O Drive não confirmou a finalização de " + f.name,
              );
            completed += f.size;
            paint(
              completed,
              prefix + f.name,
              fmt(completed) +
                " de " +
                fmt(totalBytes) +
                " enviados · confirmado pelo Drive",
              completed === totalBytes,
            );
          }
          S.materialsCache = null;
          paint(
            totalBytes,
            "Upload concluído",
            fmt(totalBytes) + " enviados e confirmados no Google Drive",
            true,
          );
          st.textContent = "Concluído ✓";
          setTimeout(() => clientShell("materials"), 1000);
        } catch (er) {
          st.textContent = "Erro: " + er.message;
          pl.textContent = "Não foi possível concluir o upload";
          pm.textContent =
            "O arquivo não foi marcado como concluído. Tente novamente.";
        } finally {
          if (inp) inp.disabled = false;
          inp.value = "";
        }
      };
    return;
  }
  if (v === "drive") {
    let x = S.materialsCache || (await A("/api/client/materials"));
    S.materialsCache = x;
    if (S.clientView !== v) return;
    view.innerHTML =
      '<div><div class="v2-eyebrow">Pasta oficial</div><h2>Drive</h2><p class="muted">Esta tela é somente uma janela para a pasta oficial da agência. O link não é alterado pelo cliente.</p></div><div class="card">' +
      (x.folder_url
        ? "<div><b>" +
          E(x.folder_name || "Sua pasta") +
          '</b><p class="muted">Os materiais exibidos no Hub vêm diretamente desta pasta.</p><a class="btn primary" href="' +
          E(x.folder_url) +
          '" target="_blank" rel="noopener">Abrir minha pasta no Drive ↗</a></div>'
        : '<div><b>Pasta ainda não vinculada</b><p class="muted">' +
          E(
            x.error || "A agência está finalizando a integração da sua pasta.",
          ) +
          "</p></div>") +
      "</div>";
    return;
  }
  if (v === "integrations") {
    let x = S.portalCache || (await A("/api/client/portal-config"));
    S.portalCache = x;
    if (S.clientView !== v) return;
    let c = x.config;
    view.innerHTML =
      '<div><div class="v2-eyebrow">Configuração de leads</div><h2>Integrações</h2><p class="muted">Só precisamos do essencial para conectar sua operação.</p></div><form id="iform" class="card grid form"><label>Sua empresa utiliza algum CRM atualmente?<select id="hcrm" name="has_crm" required><option value="">Selecione</option><option value="1" ' +
      (c.has_crm === true ? "selected" : "") +
      '>Sim</option><option value="0" ' +
      (c.has_crm === false ? "selected" : "") +
      '>Não</option></select></label><div id="cy"><label>Qual CRM?<input name="crm_name" value="' +
      E(c.crm_name || "") +
      '"></label><label>Link do CRM<input name="crm_url" type="url" value="' +
      E(c.crm_url || "") +
      '"></label><label>Login<input name="crm_login" value="' +
      E(c.crm_login || "") +
      '"></label><label>Senha<input name="crm_password" type="password" value="" placeholder="' +
      (c.crm_password_saved
        ? "Senha já salva com segurança — deixe em branco para manter"
        : "Senha de acesso") +
      '"></label>' +
      (c.crm_password_saved
        ? '<small class="muted">🔒 Senha armazenada de forma criptografada.</small>'
        : "") +
      '</div><div id="cn"><label>Para qual número devemos enviar os leads?<input name="lead_phone" value="' +
      E(c.lead_phone || "") +
      '" placeholder="(13) 99999-9999"></label></div><button class="btn primary">Salvar integração</button><small id="is" class="muted"></small></form>';
    let toggle = function () {
      let v = $("#hcrm").value;
      $("#cy").style.display = v === "1" ? "grid" : "none";
      $("#cn").style.display = v === "0" ? "grid" : "none";
    };
    toggle();
    $("#hcrm").onchange = toggle;
    $("#iform").onsubmit = async function (e) {
      e.preventDefault();
      let f = new FormData(e.target),
        s = $("#is");
      s.textContent = "Salvando…";
      let r = await A("/api/client/portal-config", {
        method: "PUT",
        body: JSON.stringify({
          has_crm:
            f.get("has_crm") === "1"
              ? true
              : f.get("has_crm") === "0"
                ? false
                : null,
          crm_name: f.get("crm_name"),
          crm_url: f.get("crm_url"),
          crm_login: f.get("crm_login"),
          crm_password: f.get("crm_password"),
          lead_phone: f.get("lead_phone"),
        }),
      });
      S.portalCache = { config: r.config };
      s.textContent = "Salvo ✓";
      clientShell("integrations");
    };
    return;
  }
  if (v === "approvals") {
    let x = S.approvalsCache || (await A("/api/client/approvals"));
    S.approvalsCache = x;
    if (S.clientView !== v) return;
    view.innerHTML =
      '<div><div class="v2-eyebrow">Validações</div><h2>Aprovações</h2><p class="muted">Materiais enviados pela agência para sua validação.</p></div><div class="grid cards">' +
      (x.approvals.length
        ? x.approvals
            .map(function (a) {
              return (
                '<div class="card"><div class="row between"><div><b>' +
                E(a.title) +
                '</b><div class="muted">' +
                F(a.created_at) +
                '</div></div><span class="pill ' +
                (a.status === "APPROVED"
                  ? "status-ok"
                  : a.status === "CHANGE_REQUESTED"
                    ? "status-warn"
                    : "status-new") +
                '">' +
                (a.status === "APPROVED"
                  ? "Aprovado"
                  : a.status === "CHANGE_REQUESTED"
                    ? "Alteração solicitada"
                    : "Aguardando você") +
                "</span></div>" +
                (a.item_url
                  ? '<a class="btn" style="margin-top:10px" href="' +
                    E(a.item_url) +
                    '" target="_blank">Visualizar ↗</a>'
                  : "") +
                (a.status === "PENDING"
                  ? '<div class="row" style="margin-top:10px"><button class="btn primary" data-aok="' +
                    a.id +
                    '">Aprovar</button><button class="btn" data-ach="' +
                    a.id +
                    '">Solicitar alteração</button></div>'
                  : "") +
                "</div>"
              );
            })
            .join("")
        : '<div class="empty-state">Nenhum material aguardando aprovação.</div>') +
      "</div>";
    $$("[data-aok]").forEach(function (b) {
      b.onclick = async function () {
        await A("/api/client/approvals", {
          method: "PUT",
          body: JSON.stringify({
            id: b.dataset.aok,
            status: "APPROVED",
            note: "",
          }),
        });
        S.approvalsCache = null;
        clientShell("approvals");
      };
    });
    $$("[data-ach]").forEach(function (b) {
      b.onclick = async function () {
        let note = prompt("O que precisa mudar?");
        if (note === null) return;
        await A("/api/client/approvals", {
          method: "PUT",
          body: JSON.stringify({
            id: b.dataset.ach,
            status: "CHANGE_REQUESTED",
            note: note,
          }),
        });
        S.approvalsCache = null;
        clientShell("approvals");
      };
    });
    return;
  }
  if (v === "requests") {
    let x = S.requestsCache || (await A("/api/client/requests"));
    S.requestsCache = x;
    if (S.clientView !== v) return;
    view.innerHTML =
      '<div class="row between"><div><div class="v2-eyebrow">Pedidos para a agência</div><h2>Solicitações</h2><p class="muted">Envie uma demanda com o contexto necessário.</p></div><button class="btn primary" id="nreq">+ Nova solicitação</button></div><div class="grid cards">' +
      (x.requests.length
        ? x.requests
            .map(function (r) {
              return (
                '<div class="card"><div class="row between"><b>' +
                E(r.request_type.replace(/_/g, " ")) +
                '</b><span class="pill ' +
                (r.status === "DONE"
                  ? "status-ok"
                  : r.status === "IN_PROGRESS"
                    ? "status-warn"
                    : "status-new") +
                '">' +
                E(
                  r.status === "RECEIVED"
                    ? "Recebida"
                    : r.status === "IN_PROGRESS"
                      ? "Em andamento"
                      : r.status === "DONE"
                        ? "Concluída"
                        : "Cancelada",
                ) +
                '</span></div><div class="muted">' +
                (r.product_name ? E(r.product_name) + " · " : "") +
                F(r.created_at) +
                "</div><p>" +
                E(r.details || "") +
                "</p></div>"
              );
            })
            .join("")
        : '<div class="empty-state">Nenhuma solicitação enviada ainda.</div>') +
      "</div>";
    $("#nreq").onclick = function () {
      requestModal(o);
    };
    return;
  }
  if (v === "history") {
    let entities = [
        ...o.products.map((x) => ({ ...x, _t: "PRODUCT" })),
        ...o.personas.map((x) => ({ ...x, _t: "PERSONA" })),
      ],
      groups =
        S.historyCache ||
        (await (S.historyPromise ||
          Promise.all(
            entities.map(async (p) => {
              let h = await A(
                "/api/client/history?type=" + p._t + "&id=" + p.id,
              );
              return h.history.map((x) => ({ ...x, entity_name: p.name }));
            }),
          )));
    S.historyCache = groups;
    if (S.clientView !== v || view !== document.getElementById("view")) return;
    let events = groups.flat();
    events.sort((a, b) =>
      String(b.changed_at).localeCompare(String(a.changed_at)),
    );
    let compact = [];
    for (let x of events) {
      let k = x.entity_name + "|" + (x.question_key || x.label || ""),
        prev = compact.find(
          (y) =>
            y._k === k &&
            Math.abs(new Date(y.changed_at) - new Date(x.changed_at)) <= 120000,
        );
      if (prev) {
        prev.old_value = x.old_value;
        continue;
      }
      x._k = k;
      compact.push(x);
    }
    events = compact;
    view.innerHTML =
      '<div><div class="v2-eyebrow">Tudo registrado</div><h2>Histórico</h2><p class="muted">Aqui você vê as alterações do seu briefing.</p></div><div class="human-history">' +
      (events.length
        ? events
            .slice(0, 80)
            .map(
              (x) =>
                '<div class="human-event"><b>' +
                E(x.entity_name) +
                " · " +
                E(x.label || x.question_key) +
                "</b><small>" +
                F(x.changed_at) +
                " · " +
                E(x.changed_by_name || "Atualizado") +
                '</small><div class="change">' +
                (x.old_value !== null &&
                x.old_value !== undefined &&
                V(x.old_value).trim()
                  ? E(V(x.old_value)) + " → "
                  : "") +
                "<b>" +
                E(V(x.new_value)) +
                "</b></div></div>",
            )
            .join("")
        : '<div class="empty-state">Nenhuma alteração registrada ainda.</div>') +
      "</div>";
    return;
  }
}
async function newEntityClient(type, productId) {
  let isP = type === "PRODUCT",
    m = modal(
      '<div class="v2-eyebrow">Novo ' +
        (isP ? "produto" : "perfil") +
        "</div><h2>" +
        (isP
          ? "Qual produto vamos trabalhar?"
          : "Como você quer chamar esta Persona?") +
        '</h2><form id="v2new" class="grid"><label>' +
        (isP ? "Nome do produto / empreendimento" : "Nome interno da Persona") +
        '<input name="name" required autofocus></label><div class="row"><button class="btn primary">Criar e começar</button><button type="button" class="btn" id="v2cancel">Cancelar</button></div></form>',
    );
  $("#v2cancel", m).onclick = () => m.remove();
  $("#v2new", m).onsubmit = async (e) => {
    e.preventDefault();
    let name = new FormData(e.target).get("name"),
      r = await A("/api/client/" + (isP ? "products" : "personas"), {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    invalidateClientCache();
    if (productId && !isP)
      await A("/api/client/link-persona", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, persona_id: r.id }),
      });
    m.remove();
    briefingMode(type, r.id, {});
  };
}
async function personaChooser(productId, o) {
  o = o || (await A("/api/client/overview"));
  let m = modal(
    '<div class="v2-eyebrow">Persona do produto</div><h2>Como você quer começar?</h2><p class="muted">Você pode criar do zero, reutilizar uma Persona já existente ou duplicar uma para adaptar.</p><div class="mode-cards"><button class="mode-card recommended" id="pcNew"><em>Novo</em><b>+ Criar nova Persona</b><span>Começar do zero para este produto.</span></button><button class="mode-card" id="pcReuse"><b>↗ Reutilizar Persona</b><span>Usar exatamente o mesmo público em mais de um produto.</span></button><button class="mode-card" id="pcDup"><b>⧉ Duplicar e adaptar</b><span>Copiar uma Persona existente e fazer ajustes sem alterar a original.</span></button></div><button class="btn" id="pcClose" style="margin-top:14px">Fechar</button>',
  );
  $("#pcClose", m).onclick = () => m.remove();
  $("#pcNew", m).onclick = () => {
    m.remove();
    newEntityClient("PERSONA", productId);
  };
  $("#pcReuse", m).onclick = () => {
    m.remove();
    reusePersonaClient(productId, o.personas);
  };
  $("#pcDup", m).onclick = () => {
    m.remove();
    pickDuplicatePersona(productId, o.personas);
  };
}
function reusePersonaClient(productId, personas) {
  let m = modal(
    '<div class="v2-eyebrow">Reutilizar</div><h2>Escolha uma Persona</h2><div class="grid">' +
      (personas.length
        ? personas
            .map(
              (p) =>
                '<button class="btn" data-reuse="' +
                p.id +
                '">' +
                E(p.name) +
                " · " +
                humanStatus(p.status) +
                "</button>",
            )
            .join("")
        : '<p class="muted">Nenhuma Persona disponível.</p>') +
      "</div>",
  );
  $$("[data-reuse]", m).forEach(
    (b) =>
      (b.onclick = async () => {
        await A("/api/client/link-persona", {
          method: "POST",
          body: JSON.stringify({
            product_id: productId,
            persona_id: b.dataset.reuse,
          }),
        });
        m.remove();
        clientShell("products");
      }),
  );
}
function pickDuplicatePersona(productId, personas) {
  let m = modal(
    '<div class="v2-eyebrow">Duplicar e adaptar</div><h2>Qual Persona será a base?</h2><div class="grid">' +
      (personas.length
        ? personas
            .map(
              (p) =>
                '<button class="btn" data-duppick="' +
                p.id +
                '">' +
                E(p.name) +
                "</button>",
            )
            .join("")
        : '<p class="muted">Nenhuma Persona disponível.</p>') +
      "</div>",
  );
  $$("[data-duppick]", m).forEach(
    (b) =>
      (b.onclick = () => {
        m.remove();
        duplicatePersonaClient(b.dataset.duppick, productId);
      }),
  );
}
async function duplicatePersonaClient(personaId, productId) {
  let o = await A("/api/client/overview"),
    src = o.personas.find((x) => x.id === personaId),
    m = modal(
      '<div class="v2-eyebrow">Nova cópia independente</div><h2>Duplicar ' +
        E(src?.name || "Persona") +
        '</h2><form id="dupform" class="grid"><label>Nome da nova Persona<input name="name" value="' +
        E((src?.name || "Persona") + " — variação") +
        '" required></label><p class="muted">As respostas atuais serão copiadas. Depois disso, as duas Personas podem evoluir separadamente.</p><button class="btn primary">Duplicar e adaptar</button></form>',
    );
  $("#dupform", m).onsubmit = async (e) => {
    e.preventDefault();
    let name = new FormData(e.target).get("name"),
      r = await A("/api/client/duplicate-persona", {
        method: "POST",
        body: JSON.stringify({ persona_id: personaId, name }),
      });
    if (productId)
      await A("/api/client/link-persona", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, persona_id: r.id }),
      });
    m.remove();
    briefingMode("PERSONA", r.id, {});
  };
}
function sectionOrderV2(type) {
  return type === "PRODUCT"
    ? [
        "Sobre o produto",
        "Localização",
        "Características",
        "Disponibilidade",
        "Estratégia",
        "Materiais e identidade",
        "Oferta e condições",
        "Complemento",
      ]
    : [
        "Quem compra",
        "Perfil",
        "Perfil avançado",
        "De onde vem",
        "Momento de compra",
        "Decisão",
        "Evidências",
        "Complemento",
      ];
}
function valsV2(b) {
  let z = {};
  Object.entries(b.answers || {}).forEach(([k, x]) => (z[k] = x.value));
  return z;
}
function ruleV2(rule, vals) {
  if (!rule) return true;
  let v = vals[rule.key];
  if (rule.notEmpty) return filledV2(v);
  if (rule.in) return rule.in.includes(v);
  if (rule.notIn) return !rule.notIn.includes(v);
  if (rule.containsAny) {
    let a = Array.isArray(v) ? v : [v];
    return a.some((x) => rule.containsAny.includes(x));
  }
  return true;
}
function filledV2(v) {
  return (
    v != null &&
    (typeof v !== "string" || v.trim() !== "") &&
    (!Array.isArray(v) || v.length > 0)
  );
}
function isRequiredV2(q, b) {
  let v = valsV2(b);
  return (
    q.required === 1 ||
    q.required === true ||
    (q.required_when && ruleV2(q.required_when, v))
  );
}
function relevantQuestionsV2(b, type, mode) {
  let vals = valsV2(b),
    quick = new Set([]);
  let qs = b.questions.filter((q) => !q.show_when || ruleV2(q.show_when, vals));
  if (mode === "COMPLETE") return qs;
  return qs.filter((q) => isRequiredV2(q, b) || quick.has(q.question_key));
}
function buildStepsV2(b, type, mode) {
  let qs = relevantQuestionsV2(b, type, mode),
    order = sectionOrderV2(type),
    sections = [...new Set(qs.map((q) => q.section_name))].sort((a, b) => {
      let ia = order.indexOf(a),
        ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    }),
    steps = [];
  sections.forEach((s, si) => {
    let arr = qs
      .filter((q) => q.section_name === s)
      .sort((a, b) => a.position - b.position);
    for (let i = 0; i < arr.length; i += 4)
      steps.push({
        kind: "questions",
        section: s,
        index: si,
        questions: arr.slice(i, i + 4),
      });
  });
  return steps;
}
function sectionCopyV2(type, s) {
  let map = {
    "Sobre o produto":
      "Primeiro, vamos situar exatamente o que será anunciado.",
    Localização:
      "Agora queremos entender o lugar pelo que realmente ajuda a vender.",
    Características:
      "Vamos registrar os fatos objetivos e diferenciais do produto.",
    Disponibilidade: "Só o que está comercialmente válido hoje.",
    Estratégia:
      "Aqui entram os motivos reais para comprar — e para não comprar.",
    "Materiais e identidade":
      "Envie o que o time precisa respeitar e usar como fonte.",
    "Oferta e condições":
      "Condições mudam. Registre apenas o que está válido agora.",
    Complemento: "Último espaço para algo importante que ficou de fora.",
    "Quem compra": "Vamos começar pelo objetivo principal deste público.",
    Perfil: "Um retrato prático, sem tentar adivinhar o que você não sabe.",
    "Perfil avançado":
      "Detalhes adicionais só quando realmente ajudarem a estratégia.",
    "De onde vem": "Origem geográfica ajuda mídia, mensagem e priorização.",
    "Momento de compra":
      "Queremos entender o gatilho de contexto que inicia a busca.",
    Decisão: "O que aproxima, trava e finalmente decide a compra.",
    Evidências: "Dados de compradores reais valem mais que suposições.",
  };
  return map[s] || "Responda apenas o que você souber com segurança.";
}
function helpV2(q) {
  let h = "";
  if (q.help_what) h += "<b>O que queremos saber</b>" + E(q.help_what);
  if (q.help_why) h += "<b>Por que isso importa</b>" + E(q.help_why);
  if (q.example_text) h += "<b>Exemplo</b>" + E(q.example_text);
  if (q.common_mistake) h += "<b>O que evitar</b>" + E(q.common_mistake);
  return h
    ? '<details class="v2help"><summary>ⓘ Por que perguntamos isso?</summary><div class="helpbox">' +
        h +
        "</div></details>"
    : "";
}
function assistOptionsV2(q) {
  let m = {
    "persona.desires": [
      "Mais espaço",
      "Segurança",
      "Boa localização",
      "Valorização patrimonial",
      "Praticidade na rotina",
    ],
    "persona.fears": [
      "Comprar acima do valor",
      "Financiamento ruim",
      "Região não valorizar",
      "Escolher o produto errado",
    ],
    "persona.objections": [
      "Preço",
      "Prazo",
      "Localização",
      "Entrada",
      "Condição de pagamento",
    ],
    "product.differentials": [
      "Localização",
      "Planta",
      "Lazer",
      "Condição comercial",
      "Padrão construtivo",
    ],
    "product.buy_reason": [
      "Rotina melhor",
      "Patrimônio",
      "Localização",
      "Condição comercial",
      "Qualidade do produto",
    ],
  };
  return m[q.question_key] || [];
}
function filesForQ(q) {
  return (S.bm.files || []).filter((f) => f.question_key === q.question_key);
}
function inputV2(q, v) {
  let key = E(q.question_key),
    id = "q_" + key.replace(/[^a-z0-9]/gi, "_");
  if (
    q.input_type === "SELECT" ||
    q.input_type === "MULTISELECT" ||
    q.input_type === "BOOLEAN"
  ) {
    let opts =
        q.input_type === "BOOLEAN"
          ? ["Sim", "Não"]
          : Array.isArray(q.options)
            ? q.options
            : [],
      multi = q.input_type === "MULTISELECT";
    return (
      '<div class="choices" role="group" aria-label="' +
      E(q.label) +
      '">' +
      opts
        .map((x) => {
          let on = multi
            ? Array.isArray(v) && v.includes(x)
            : String(v ?? "") === String(x);
          return (
            '<button type="button" class="choice ' +
            (on ? "on" : "") +
            '" aria-pressed="' +
            (on ? "true" : "false") +
            '" data-choice="' +
            E(x) +
            '" data-qchoice="' +
            key +
            '" data-multi="' +
            (multi ? "1" : "0") +
            '">' +
            E(x) +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }
  if (q.input_type === "TEXTAREA")
    return (
      '<textarea id="' +
      id +
      '" data-binput="' +
      key +
      '" aria-label="' +
      E(q.label) +
      '">' +
      E(V(v)) +
      "</textarea>"
    );
  let ty =
      q.input_type === "NUMBER" || q.input_type === "CURRENCY"
        ? "number"
        : q.input_type === "DATE"
          ? "date"
          : q.input_type === "URL"
            ? "url"
            : "text",
    step = q.input_type === "CURRENCY" ? ' step="0.01"' : "";
  return (
    '<input id="' +
    id +
    '" type="' +
    ty +
    '"' +
    step +
    ' data-binput="' +
    key +
    '" value="' +
    E(V(v)) +
    '" aria-label="' +
    E(q.label) +
    '">'
  );
}
function questionHtmlV2(q) {
  let bm = S.bm,
    v = bm.b.answers[q.question_key]?.value,
    req = isRequiredV2(q, bm.b),
    flag = bm.flags.has(q.question_key),
    files = filesForQ(q),
    assist = assistOptionsV2(q),
    known = Object.prototype.hasOwnProperty.call(bm.initial, q.question_key);
  return (
    '<section class="qv2" data-qcard="' +
    E(q.question_key) +
    '">' +
    (q.input_type === "SELECT" ||
    q.input_type === "MULTISELECT" ||
    q.input_type === "BOOLEAN"
      ? "<fieldset><legend>" +
        E(q.label) +
        (req ? '<span class="required-star">*</span>' : "") +
        (known ? '<span class="preknown">✓ já tínhamos isso</span>' : "") +
        "</legend>"
      : '<label class="qlabel" for="q_' +
        E(q.question_key).replace(/[^a-z0-9]/gi, "_") +
        '">' +
        E(q.label) +
        (req ? '<span class="required-star">*</span>' : "") +
        (known ? '<span class="preknown">✓ já tínhamos isso</span>' : "") +
        "</label>") +
    helpV2(q) +
    (flag
      ? '<div class="review-flagged"><span>✓ Nosso time vai revisar esta informação.</span><button type="button" class="btn" data-unflag="' +
        E(q.question_key) +
        '">Responder agora</button></div>'
      : "") +
    inputV2(q, v) +
    (q.input_type === "SELECT" ||
    q.input_type === "MULTISELECT" ||
    q.input_type === "BOOLEAN"
      ? "</fieldset>"
      : "") +
    (assist.length
      ? '<div class="assist"><button type="button" class="assist-btn" data-assist="' +
        E(q.question_key) +
        '">✦ Me ajude a responder</button><div class="assist-box" data-assistbox="' +
        E(q.question_key) +
        '" hidden>' +
        assist
          .map(
            (x) =>
              '<button type="button" class="assist-chip" data-suggest="' +
              E(x) +
              '" data-suggest-q="' +
              E(q.question_key) +
              '">+ ' +
              E(x) +
              "</button>",
          )
          .join("") +
        "</div></div>"
      : "") +
    (q.allow_unknown
      ? '<div class="review-later"><span>Não sabe responder?</span><button type="button" class="review-toggle" data-unknown="' +
        E(q.question_key) +
        '">Deixar para o time analisar</button></div>'
      : "") +
    (q.allow_files
      ? '<div class="dropzone" data-drop="' +
        E(q.question_key) +
        '" role="button" tabindex="0"><b>Anexar arquivo</b><span>PDF, imagem ou documento · até 5 MB</span><input type="file" data-file-input="' +
        E(q.question_key) +
        '" hidden></div><div class="file-list">' +
        files
          .map(
            (f) =>
              '<div class="file-row"><a href="/api/client/file?id=' +
              f.id +
              '" target="_blank">' +
              E(f.file_name) +
              " · " +
              Math.max(1, Math.round((f.size_bytes || 0) / 1024)) +
              ' KB</a><button type="button" aria-label="Remover arquivo" data-rmfile="' +
              f.id +
              '">Remover</button></div>',
          )
          .join("") +
        "</div>"
      : "") +
    '<div class="inline-error" role="alert" data-qerror="' +
    E(q.question_key) +
    '"></div></section>'
  );
}
async function briefingMode(type, id, opts) {
  let [b, pr, fl] = await Promise.all([
    A("/api/client/entity?type=" + type + "&id=" + id),
    A("/api/client/progress?type=" + type + "&id=" + id),
    A("/api/client/files?type=" + type + "&id=" + id),
  ]);
  S.entityCache[type + ":" + id] = b;
  S.bm = {
    type,
    id,
    b,
    progress: pr.progress,
    stats: pr.stats,
    flags: new Set((pr.flags || []).map((x) => x.question_key)),
    files: fl.files || [],
    initial: Object.fromEntries(
      Object.entries(b.answers || {}).filter(([k, x]) => filledV2(x.value)),
    ),
    mode: pr.progress?.fill_mode || null,
    step: Number(pr.progress?.current_step || 0),
    saveTimer: {},
    saveVersion: {},
    saveChains: {},
    pendingSaves: {},
  };
  if (opts?.summary && pr.progress?.submitted_at) return summaryBriefV2();
  if (!S.bm.mode) return modeChoiceV2();
  S.bm.steps = buildStepsV2(b, type, S.bm.mode);
  if (pr.progress?.current_question_key) {
    let ix = S.bm.steps.findIndex((x) =>
      x.questions?.some(
        (q) => q.question_key === pr.progress.current_question_key,
      ),
    );
    if (ix >= 0) S.bm.step = ix;
  }
  if (opts?.review) return reviewBriefV2();
  renderBriefV2();
}
function modeChoiceV2() {
  let bm = S.bm;
  document.getElementById("app").innerHTML =
    '<main class="mode-choose"><div class="mode-box v2-fade"><button class="btn" id="modeExit">← Voltar aos meus projetos</button><div class="v2-eyebrow" style="margin-top:28px">' +
    (bm.type === "PRODUCT" ? "Produto" : "Persona") +
    " · " +
    E(bm.b.entity.name) +
    '</div><h1>Como prefere preencher?</h1><p>As duas opções usam o mesmo briefing. O modo rápido mostra apenas o essencial; você pode completar os demais detalhes depois.</p><div class="mode-cards"><button class="mode-card recommended" data-mode="QUICK"><em>Recomendado</em><b>Rápido</b><span>5–7 minutos · somente informações essenciais.</span></button><button class="mode-card" data-mode="COMPLETE"><b>Completo</b><span>10–15 minutos · mais detalhes para estratégia.</span></button></div></div></main>';
  $("#modeExit").onclick = () => clientShell("home");
  $$("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        bm.mode = b.dataset.mode;
        bm.steps = buildStepsV2(bm.b, bm.type, bm.mode);
        bm.step = 0;
        renderBriefV2();
        A("/api/client/progress", {
          method: "PUT",
          body: JSON.stringify({
            type: bm.type,
            id: bm.id,
            fill_mode: bm.mode,
            current_step: 0,
          }),
        }).catch((e) => console.warn("briefing mode save failed", e));
      }),
  );
}
function briefCountsV2() {
  let bm = S.bm,
    qs = relevantQuestionsV2(bm.b, bm.type, bm.mode),
    done = qs.filter(
      (q) =>
        filledV2(bm.b.answers[q.question_key]?.value) ||
        bm.flags.has(q.question_key),
    ).length;
  return {
    done,
    total: qs.length,
    percent: qs.length ? Math.round((done * 100) / qs.length) : 100,
    remain: Math.max(0, qs.length - done),
  };
}
function railV2(step) {
  let bm = S.bm,
    order = [...new Set(bm.steps.map((x) => x.section))],
    cur = step.section;
  return (
    '<aside class="bmode-rail" aria-label="Etapas do briefing">' +
    order
      .map((s) => {
        let first = bm.steps.findIndex((x) => x.section === s),
          last = bm.steps.map((x) => x.section).lastIndexOf(s),
          cl = bm.step > last ? "done" : s === cur ? "current" : "",
          enabled = first <= bm.step;
        return (
          '<button type="button" class="rail-item ' +
          cl +
          '" data-rail-step="' +
          first +
          '" ' +
          (enabled ? "" : "disabled") +
          '><span class="rail-dot"></span>' +
          E(s) +
          "</button>"
        );
      })
      .join("") +
    "</aside>"
  );
}
function topV2(step) {
  let c = briefCountsV2(),
    mins = Math.max(1, Math.ceil(c.remain * 0.55)),
    sections = [...new Set(S.bm.steps.map((x) => x.section))],
    si = Math.max(0, sections.indexOf(step.section));
  return (
    '<header class="bmode-top"><div class="bmode-topline"><div class="bmode-brand"><div class="bmode-mark">MP</div><div class="bmode-title"><b>' +
    E(S.bm.b.entity.name) +
    "</b><small>" +
    (S.bm.type === "PRODUCT" ? "Produto" : "Persona") +
    " · " +
    (S.bm.mode === "QUICK" ? "modo rápido" : "modo completo") +
    '</small></div></div><div class="save-state ok" id="saveState">✓ Salvo</div></div><div class="bmode-stage"><b>' +
    E(step.section) +
    "</b><span>Etapa " +
    (si + 1) +
    " de " +
    sections.length +
    '</span></div><div class="bmode-progress">' +
    pbarHtml(c.percent) +
    "<small><b>" +
    c.percent +
    "%</b> · " +
    c.done +
    " de " +
    c.total +
    " informações · aprox. " +
    mins +
    " min restantes</small></div></header>"
  );
}
function renderBriefV2() {
  let bm = S.bm;
  bm.steps = buildStepsV2(bm.b, bm.type, bm.mode);
  if (!bm.steps.length) return reviewBriefV2();
  bm.step = Math.max(0, Math.min(bm.step, bm.steps.length - 1));
  let step = bm.steps[bm.step],
    main =
      '<section class="question-stage"><header class="question-stage-head"><div class="v2-eyebrow">' +
      E(step.section) +
      "</div><h1>Conte o que você sabe.</h1><p>Responda com calma. Tudo é salvo automaticamente.</p></header>" +
      step.questions.map(questionHtmlV2).join("") +
      "</section>";
  document.getElementById("app").innerHTML =
    '<main class="bmode">' +
    topV2(step) +
    '<div class="bmode-body">' +
    railV2(step) +
    '<div class="bmode-main">' +
    main +
    '</div></div><footer class="bmode-actions"><button class="btn" id="bBack">' +
    (bm.step === 0 ? "Sair" : "← Voltar") +
    '</button><button class="btn primary" id="bNext">' +
    (bm.step === bm.steps.length - 1 ? "Revisar briefing" : "Continuar →") +
    "</button></footer></main>";
  bindBriefV2(step);
}
function bindBriefV2(step) {
  let bm = S.bm,
    grow = (el) => {
      if (el.tagName === "TEXTAREA") {
        el.style.height = "auto";
        el.style.height = Math.min(360, Math.max(112, el.scrollHeight)) + "px";
      }
    };
  $("#bBack").onclick = () => {
    if (bm.step === 0) return clientShell("home");
    goBriefV2(-1);
  };
  $("#bNext").onclick = () => goBriefV2(1);
  $$("[data-rail-step]").forEach(
    (bt) =>
      (bt.onclick = () => {
        if (bt.disabled) return;
        bm.step = Number(bt.dataset.railStep) || 0;
        renderBriefV2();
        window.scrollTo(0, 0);
      }),
  );
  $$("[data-binput]").forEach((el) => {
    grow(el);
    let fire = () => {
      let k = el.dataset.binput;
      grow(el);
      bm.b.answers[k] = { value: el.value };
      bm.flags.delete(k);
      clearTimeout(bm.saveTimer[k]);
      bm.saveTimer[k] = setTimeout(
        () => saveBriefAnswerV2(k, el.value, false),
        450,
      );
    };
    el.oninput = fire;
    el.onchange = () => {
      fire();
      let k = el.dataset.binput;
      clearTimeout(bm.saveTimer[k]);
      saveBriefAnswerV2(k, el.value, true);
    };
  });
  $$("[data-qchoice]").forEach(
    (bt) =>
      (bt.onclick = () => {
        let k = bt.dataset.qchoice,
          cur = bm.b.answers[k]?.value,
          multi = bt.dataset.multi === "1",
          nv;
        if (multi) {
          let a = Array.isArray(cur) ? [...cur] : [],
            ix = a.indexOf(bt.dataset.choice);
          ix >= 0 ? a.splice(ix, 1) : a.push(bt.dataset.choice);
          nv = a;
        } else nv = bt.dataset.choice;
        saveBriefAnswerV2(k, nv, true);
        renderBriefV2();
      }),
  );
  $$("[data-unknown]").forEach(
    (bt) =>
      (bt.onclick = () => {
        setReviewV2(bt.dataset.unknown, true);
        renderBriefV2();
      }),
  );
  $$("[data-unflag]").forEach(
    (bt) =>
      (bt.onclick = () => {
        setReviewV2(bt.dataset.unflag, false);
        renderBriefV2();
      }),
  );
  $$("[data-assist]").forEach(
    (bt) =>
      (bt.onclick = () => {
        let x = $('[data-assistbox="' + bt.dataset.assist + '"]');
        x.hidden = !x.hidden;
      }),
  );
  $$("[data-suggest]").forEach(
    (bt) =>
      (bt.onclick = () => {
        let k = bt.dataset.suggestQ,
          cur = String(bm.b.answers[k]?.value || ""),
          nv = cur
            ? cur + (cur.trim().endsWith(".") ? " " : "; ") + bt.dataset.suggest
            : bt.dataset.suggest;
        saveBriefAnswerV2(k, nv, true);
        renderBriefV2();
      }),
  );
  $$("[data-drop]").forEach((z) => {
    let inp = $('[data-file-input="' + z.dataset.drop + '"]');
    z.onclick = () => inp.click();
    z.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        inp.click();
      }
    };
    z.ondragover = (e) => {
      e.preventDefault();
      z.classList.add("drag");
    };
    z.ondragleave = () => z.classList.remove("drag");
    z.ondrop = (e) => {
      e.preventDefault();
      z.classList.remove("drag");
      if (e.dataTransfer.files[0])
        uploadFileV2(z.dataset.drop, e.dataTransfer.files[0]);
    };
    inp.onchange = () => {
      if (inp.files[0]) uploadFileV2(z.dataset.drop, inp.files[0]);
    };
  });
  $$("[data-rmfile]").forEach(
    (bt) => (bt.onclick = () => removeFileV2(bt.dataset.rmfile)),
  );
}
async function saveBriefAnswerV2(key, value, nowSave) {
  let bm = S.bm,
    s = $("#saveState"),
    ver = (bm.saveVersion[key] || 0) + 1;
  bm.saveVersion[key] = ver;
  bm.b.answers[key] = { value };
  bm.flags.delete(key);
  if (s) {
    s.textContent = "Salvando…";
    s.classList.remove("ok");
  }
  let req = (bm.saveChains[key] || Promise.resolve())
    .catch(() => {})
    .then(() =>
      A("/api/client/answer", {
        method: "PUT",
        body: JSON.stringify({ type: bm.type, id: bm.id, key, value }),
      }),
    );
  bm.saveChains[key] = req;
  bm.pendingSaves[key] = req;
  try {
    await req;
    if (S.bm === bm && bm.saveVersion[key] === ver && s) {
      s.textContent = "✓ Salvo";
      s.classList.add("ok");
    }
    return true;
  } catch (e) {
    if (S.bm === bm && bm.saveVersion[key] === ver && s) {
      s.textContent = "Erro ao salvar · tente novamente";
      s.classList.remove("ok");
    }
    return false;
  } finally {
    if (bm.pendingSaves[key] === req) delete bm.pendingSaves[key];
  }
}
async function setReviewV2(key, on) {
  let bm = S.bm,
    was = bm.flags.has(key),
    pendingKey = "flag:" + key;
  on ? bm.flags.add(key) : bm.flags.delete(key);
  let req = A("/api/client/review-flag", {
    method: "PUT",
    body: JSON.stringify({ type: bm.type, id: bm.id, key, review_needed: on }),
  });
  bm.pendingSaves[pendingKey] = req;
  try {
    await req;
    return true;
  } catch (e) {
    was ? bm.flags.add(key) : bm.flags.delete(key);
    let s = $("#saveState");
    if (s) s.textContent = "Erro ao salvar · tente novamente";
    return false;
  } finally {
    if (bm.pendingSaves[pendingKey] === req) delete bm.pendingSaves[pendingKey];
  }
}
async function uploadFileV2(key, file) {
  if (file.size > 5 * 1024 * 1024)
    return alert(
      "Este arquivo ultrapassa 5 MB. Para arquivos maiores, inclua um link no campo de resposta.",
    );
  let bm = S.bm,
    s = $("#saveState");
  if (s) s.textContent = "Enviando arquivo…";
  let data = await new Promise((res, rej) => {
      let r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    }),
    x = await A("/api/client/files", {
      method: "POST",
      body: JSON.stringify({
        type: bm.type,
        id: bm.id,
        key,
        file_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
        data_base64: data,
      }),
    });
  bm.files.unshift(x.file);
  renderBriefV2();
}
async function removeFileV2(fid) {
  let bm = S.bm;
  await A("/api/client/files?file_id=" + encodeURIComponent(fid), {
    method: "DELETE",
  });
  bm.files = bm.files.filter((x) => x.id !== fid);
  renderBriefV2();
}
function validateStepV2(step) {
  let bm = S.bm,
    ok = true;
  if (step.kind !== "questions") return true;
  step.questions.forEach((q) => {
    let req = isRequiredV2(q, bm.b),
      el = $('[data-binput="' + q.question_key + '"]'),
      value = el ? el.value : bm.b.answers[q.question_key]?.value,
      done = filledV2(value) || bm.flags.has(q.question_key),
      card = $('[data-qcard="' + q.question_key + '"]'),
      er = $('[data-qerror="' + q.question_key + '"]');
    if (req && !done) {
      ok = false;
      card?.classList.add("has-error");
      if (er)
        er.textContent =
          "Precisamos desta informação para avançar — ou marque para o time analisar.";
    } else {
      card?.classList.remove("has-error");
      if (er) er.textContent = "";
    }
  });
  return ok;
}
async function goBriefV2(delta) {
  let bm = S.bm,
    old = bm.steps?.[bm.step];
  if (delta > 0 && !validateStepV2(old)) return;
  let steps = buildStepsV2(bm.b, bm.type, bm.mode);
  if (!steps.length) return reviewBriefV2();
  let current = -1;
  if (old?.kind === "questions") {
    let keys = new Set((old.questions || []).map((q) => q.question_key));
    current = steps.findIndex(
      (x) =>
        x.kind === "questions" &&
        (x.questions || []).some((q) => keys.has(q.question_key)),
    );
  } else if (old?.section)
    current = steps.findIndex(
      (x) => x.kind === "intro" && x.section === old.section,
    );
  if (current < 0)
    current = Math.max(0, Math.min(Number(bm.step) || 0, steps.length - 1));
  if (delta > 0 && current >= steps.length - 1) return reviewBriefV2();
  let next = Math.max(0, Math.min(current + delta, steps.length - 1));
  if (delta > 0 && next === current && current < steps.length - 1)
    next = current + 1;
  bm.steps = steps;
  bm.step = next;
  let cur = steps[next];
  renderBriefV2();
  window.scrollTo(0, 0);
  try {
    await A("/api/client/progress", {
      method: "PUT",
      body: JSON.stringify({
        type: bm.type,
        id: bm.id,
        fill_mode: bm.mode,
        current_section: cur.section,
        current_question_key:
          cur.kind === "questions" ? cur.questions[0]?.question_key : null,
        current_step: next,
      }),
    });
  } catch (e) {
    console.warn("briefing progress save failed", e);
  }
}
async function reviewBriefV2() {
  let bm = S.bm,
    pending = Object.values(bm.pendingSaves || {});
  if (pending.length) await Promise.allSettled(pending);
  let rv = await A("/api/client/review?type=" + bm.type + "&id=" + bm.id),
    qs = relevantQuestionsV2(bm.b, bm.type, bm.mode),
    sections = [...new Set(qs.map((q) => q.section_name))].sort((a, b) => {
      let o = sectionOrderV2(bm.type),
        ia = o.indexOf(a),
        ib = o.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    }),
    flagSet = new Set((rv.review_flags || []).map((x) => x.question_key)),
    missingSet = new Set((rv.missing || []).map((x) => x.question_key)),
    answer = (q) => {
      if (flagSet.has(q.question_key)) return "Para o time analisar";
      let v = bm.b.answers[q.question_key]?.value;
      if (Array.isArray(v)) return v.join(" · ");
      return filledV2(v) ? V(v) : "Não informado";
    };
  document.getElementById("app").innerHTML =
    '<main class="bmode review-mode">' +
    topV2({ section: "Revisão" }) +
    '<div class="review-shell"><header class="review-hero"><div class="v2-eyebrow">Revisão final</div><h1>Seu briefing está pronto para revisão.</h1><p>Confira por etapa. Você pode voltar direto para qualquer informação antes de enviar.</p></header><div class="review-groups">' +
    sections
      .map((s, si) => {
        let sq = qs.filter((q) => q.section_name === s),
          miss = sq.filter((q) => missingSet.has(q.question_key)).length,
          flags = sq.filter((q) => flagSet.has(q.question_key)).length,
          txt = miss
            ? miss === 1
              ? "1 obrigatória pendente"
              : miss + " obrigatórias pendentes"
            : flags
              ? flags === 1
                ? "1 informação para o time analisar"
                : flags + " informações para o time analisar"
              : "Completo",
          cl = miss ? "missing" : flags ? "warn" : "complete";
        return (
          '<details class="review-group ' +
          cl +
          '" ' +
          (si === 0 || miss ? "open" : "") +
          "><summary><span><b>" +
          E(s) +
          "</b><small>" +
          E(txt) +
          '</small></span><span class="review-status">' +
          (miss ? "!" : flags ? "○" : "✓") +
          '</span></summary><div class="review-answers">' +
          sq
            .map(
              (q) =>
                '<button type="button" class="review-answer ' +
                (missingSet.has(q.question_key) ? "is-missing" : "") +
                '" data-edit-key="' +
                E(q.question_key) +
                '"><span>' +
                E(q.label) +
                "</span><b>" +
                E(answer(q)) +
                "</b></button>",
            )
            .join("") +
          "</div></details>"
        );
      })
      .join("") +
    "</div>" +
    (rv.missing.length
      ? '<section class="review-warning review-missing"><b>' +
        rv.missing.length +
        " " +
        (rv.missing.length === 1
          ? "informação obrigatória precisa"
          : "informações obrigatórias precisam") +
        " de resposta.</b><div>" +
        rv.missing
          .map(
            (x) =>
              '<button type="button" data-edit-key="' +
              E(x.question_key) +
              '">Responder ' +
              E(x.label) +
              "</button>",
          )
          .join("") +
        "</div></section>"
      : "") +
    (rv.review_flags.length
      ? '<section class="review-warning"><b>' +
        rv.review_flags.length +
        " " +
        (rv.review_flags.length === 1
          ? "informação será analisada"
          : "informações serão analisadas") +
        " pelo nosso time.</b></section>"
      : "") +
    '</div><footer class="bmode-actions"><button class="btn" id="reviewBack">← Voltar ao preenchimento</button><button class="btn primary" id="reviewSend" ' +
    (rv.missing.length ? "disabled" : "") +
    ">Enviar briefing</button></footer></main>";
  $("#reviewBack").onclick = () => renderBriefV2();
  $("#reviewSend").onclick = () => submitBriefV2();
  $$("[data-edit-key]").forEach(
    (bt) =>
      (bt.onclick = () => {
        let ix = bm.steps.findIndex((x) =>
          x.questions?.some((q) => q.question_key === bt.dataset.editKey),
        );
        bm.step = ix >= 0 ? ix : 0;
        renderBriefV2();
        setTimeout(() => {
          $('[data-qcard="' + bt.dataset.editKey + '"]')?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 30);
      }),
  );
}
async function submitBriefV2() {
  let bm = S.bm,
    bt = $("#reviewSend");
  if (bt) {
    bt.disabled = true;
    bt.textContent = "Enviando…";
  }
  try {
    let r = await A("/api/client/submit", {
      method: "POST",
      body: JSON.stringify({ type: bm.type, id: bm.id }),
    });
    invalidateClientCache();
    bm.progress = { ...(bm.progress || {}), submitted_at: r.submitted_at };
    summaryBriefV2();
  } catch (e) {
    if (bt) {
      bt.disabled = false;
      bt.textContent = "Enviar briefing";
    }
    alert("Ainda existe uma informação obrigatória pendente.");
  }
}
function summaryItemV2(label, v) {
  if (!filledV2(v)) return "";
  return (
    '<div class="summary-item"><small>' +
    E(label) +
    "</small><b>" +
    E(V(v)) +
    "</b></div>"
  );
}
function summaryBriefV2() {
  let bm = S.bm,
    a = valsV2(bm.b),
    items =
      bm.type === "PRODUCT"
        ? [
            ["Tipo", a["product.type"]],
            ["Localização", a["product.location"]],
            ["Preço", a["product.price"]],
            ["Diferenciais", a["product.differentials"]],
            ["Motivos de compra", a["product.buy_reason"]],
            ["Condições", a["product.special_offer"]],
          ]
        : [
            ["Intenção", a["persona.intent"]],
            ["Faixa etária", a["persona.age_range"]],
            ["Renda", a["persona.income_range"]],
            ["Região de origem", a["persona.location"]],
            ["Desejos", a["persona.desires"]],
            ["Objeções", a["persona.objections"]],
          ],
    sent = bm.progress?.submitted_at
      ? F(bm.progress.submitted_at)
      : F(new Date().toISOString());
  document.getElementById("app").innerHTML =
    '<main class="mode-choose"><section class="mode-box summary-page v2-fade"><div class="success-check">✓</div><div class="v2-eyebrow" style="margin-top:18px">Briefing recebido</div><h1>Enviado com sucesso.</h1><p>Nosso time já pode usar essas informações para estruturar as próximas etapas.</p><div class="summary-card"><div class="project-card-head"><div><div class="v2-eyebrow">' +
    (bm.type === "PRODUCT" ? "Produto" : "Persona") +
    "</div><h2>" +
    E(bm.b.entity.name) +
    "</h2><small>Enviado em " +
    E(sent) +
    '</small></div><span class="pill status-ok">Recebido ✓</span></div><div class="summary-grid">' +
    items.map((x) => summaryItemV2(x[0], x[1])).join("") +
    "</div>" +
    (bm.files.length
      ? '<p class="muted" style="margin-top:14px">' +
        bm.files.length +
        " " +
        (bm.files.length === 1 ? "arquivo anexado" : "arquivos anexados") +
        "</p>"
      : "") +
    '</div><div class="summary-actions"><button class="btn primary" id="sumProjects">Voltar aos meus projetos</button><button class="btn" id="sumReview">Visualizar resumo</button><a class="btn pdf-action" href="/api/client/pdf?type=' +
    bm.type +
    "&id=" +
    bm.id +
    '" download>↓ Baixar PDF</a></div></section></main>';
  $("#sumProjects").onclick = () => clientShell("home");
  $("#sumReview").onclick = () => reviewBriefV2();
}
async function client(cid) {
  S.cid = cid;
  let r = await A("/api/staff/client?id=" + cid),
    view = document.getElementById("view");
  view.innerHTML =
    '<div class="row between"><div><button class="btn" id="back">← Clientes</button><h2>' +
    E(r.client.name) +
    '</h2></div><div class="row"><button class="btn" id="brand">Marca e Mercado</button><button class="btn" id="access">Acesso cliente</button><button class="btn primary" id="np">+ Produto</button><button class="btn" id="ne">+ Persona</button></div></div><h3>Produtos</h3><div class="grid cards">' +
    r.products
      .map(
        (p) =>
          '<div class="card"><div class="row between"><b>' +
          E(p.name) +
          "</b>" +
          pill(p.briefing_status) +
          '</div><div class="row" style="margin-top:10px"><button class="btn" data-po="' +
          p.id +
          '">Abrir</button><button class="btn" data-li="' +
          p.id +
          '">Vincular Persona</button></div></div>',
      )
      .join("") +
    '</div><h3>Personas</h3><div class="grid cards">' +
    r.personas
      .map(
        (p) =>
          '<div class="card"><div class="row between"><b>' +
          E(p.name) +
          "</b>" +
          pill(p.status) +
          '</div><button class="btn" data-pe="' +
          p.id +
          '">Abrir</button></div>',
      )
      .join("") +
    '</div><h3>Acessos</h3><div class="card"><table><tr><th>Nome</th><th>Usuário</th><th>ÃÂÃÂltimo acesso</th></tr>' +
    r.users
      .map(
        (u) =>
          "<tr><td>" +
          E(u.display_name) +
          "</td><td><code>" +
          E(u.username || "—") +
          "</code></td><td>" +
          F(u.last_login_at) +
          "</td></tr>",
      )
      .join("") +
    "</table></div>";
  document.getElementById("back").onclick = () => staffView("clients");
  document.getElementById("brand").onclick = () => accountView(cid);
  document.getElementById("np").onclick = () =>
    create("products", cid, "Nome do produto");
  document.getElementById("ne").onclick = () =>
    create("personas", cid, "Nome da persona");
  $$("[data-po]").forEach(
    (b) => (b.onclick = () => open("PRODUCT", b.dataset.po)),
  );
  $$("[data-pe]").forEach(
    (b) => (b.onclick = () => open("PERSONA", b.dataset.pe)),
  );
  $$("[data-li]").forEach(
    (b) => (b.onclick = () => link(b.dataset.li, r.personas)),
  );
  document.getElementById("access").onclick = () => {
    let m = modal(
      '<h2>Criar acesso do cliente</h2><form id="af" class="grid"><input name="display_name" placeholder="Nome"><input name="username" placeholder="Usuário (sem espaÃÂÃÂ§os)" required><input name="password" placeholder="Senha temporária" minlength="8" required><button class="btn primary">Criar</button></form>',
    );
    document.getElementById("af").onsubmit = async (e) => {
      e.preventDefault();
      let b = Object.fromEntries(new FormData(e.target));
      b.client_id = cid;
      await A("/api/staff/client-user", {
        method: "POST",
        body: JSON.stringify(b),
      });
      m.remove();
      client(cid);
    };
  };
}
async function staffView(v) {
  let o = await A("/api/staff/overview"),
    view = document.getElementById("view");
  if (v === "clients") {
    view.innerHTML =
      '<div class="row between"><input id="search" placeholder="Buscar cliente ou empreendimento"><button class="btn primary" id="nc">+ Cliente</button></div><div class="card" style="margin-top:14px"><table><tr><th>Cliente</th><th>Produtos</th><th>Personas</th><th></th></tr>' +
      o.clients
        .map(
          (c) =>
            "<tr><td><b>" +
            E(c.name) +
            "</b></td><td>" +
            c.product_count +
            "</td><td>" +
            c.persona_count +
            '</td><td><button class="btn" data-c="' +
            c.id +
            '">Abrir</button></td></tr>',
        )
        .join("") +
      "</table></div>";
    $$("[data-c]").forEach((b) => (b.onclick = () => client(b.dataset.c)));
    document.getElementById("search").oninput = async (e) => {
      let x = await A(
        "/api/staff/overview?q=" + encodeURIComponent(e.target.value),
      );
      let tb = $("table");
      tb.innerHTML =
        "<tr><th>Cliente</th><th>Produtos</th><th>Personas</th><th></th></tr>" +
        x.clients
          .map(
            (c) =>
              "<tr><td><b>" +
              E(c.name) +
              "</b></td><td>" +
              c.product_count +
              "</td><td>" +
              c.persona_count +
              '</td><td><button class="btn" data-c="' +
              c.id +
              '">Abrir</button></td></tr>',
          )
          .join("");
      $$("[data-c]").forEach((b) => (b.onclick = () => client(b.dataset.c)));
    };
    document.getElementById("nc").onclick = () => {
      let m = modal(
        '<h2>Novo cliente</h2><form id="nf" class="grid"><input name="name" placeholder="Cliente / imobiliária" required><button class="btn primary">Criar</button></form>',
      );
      document.getElementById("nf").onsubmit = async (e) => {
        e.preventDefault();
        let r = await A("/api/staff/clients", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        m.remove();
        client(r.id);
      };
    };
  } else {
    view.innerHTML =
      '<h2>Atualizações recentes</h2><div class="card history">' +
      o.recent
        .map(
          (x) =>
            '<div class="hist"><b>' +
            E(x.client_name) +
            " · " +
            E(x.entity_name) +
            " · " +
            E(x.question_key) +
            '</b><div class="muted">' +
            F(x.changed_at) +
            " · " +
            E(x.changed_by_name || x.changed_by_type) +
            "</div><div>" +
            E(V(x.old_value)) +
            " → <b>" +
            E(V(x.new_value)) +
            "</b></div></div>",
        )
        .join("") +
      "</div>";
  }
}
async function init() {
  try {
    if (M === "STAFF" && location.hash.startsWith("#access_token=")) {
      let t = decodeURIComponent(location.hash.slice(14));
      history.replaceState(null, "", location.pathname);
      await A("/api/staff/sso", {
        method: "POST",
        body: JSON.stringify({ access_token: t }),
      });
    }
    let m = await A("/api/" + (M === "STAFF" ? "staff" : "client") + "/me");
    if (M === "CLIENT" && m.user.must_change_password) {
      document.getElementById("app").innerHTML =
        '<div class="login"><div class="card"><h2>Crie sua nova senha</h2><form id="pw" class="grid"><input name="password" type="password" minlength="8" required><button class="btn primary">Salvar</button></form></div></div>';
      document.getElementById("pw").onsubmit = async (e) => {
        e.preventDefault();
        await A("/api/client/password", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        location.reload();
      };
      return;
    }
    shell();
    if (M === "CLIENT") {
      S.me = m.user;
      let qp = new URLSearchParams(location.search),
        bt = String(qp.get("briefType") || "").toUpperCase(),
        bi = qp.get("briefId");
      if ((bt === "PRODUCT" || bt === "PERSONA") && bi)
        briefingMode(bt, bi, {
          review: qp.get("review") === "1",
          summary: qp.get("summary") === "1",
        });
      else {
        let tv = String(qp.get("tab") || "home"),
          allowed = [
            "home",
            "products",
            "personas",
            "materials",
            "drive",
            "integrations",
            "history",
          ];
        clientShell(allowed.includes(tv) ? tv : "home");
      }
    } else {
      buildNav(
        [
          ["clients", "Clientes"],
          ["recent", "Atualizações"],
        ],
        staffView,
      );
      staffView("clients");
    }
  } catch {
    login();
  }
}
init();
