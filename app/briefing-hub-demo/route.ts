const PRIMARY_HUB = "https://agency-briefing-hub.lakassessoriadigital.workers.dev/cliente";

const DEMO_SCRIPT = String.raw`
(() => {
  const now = "2026-09-02T14:30:00.000Z";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const keyFor = (type, id) => String(type || "").toUpperCase() + ":" + String(id || "");
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  const progressOf = (percent, done, total, section, submitted = null, fillMode = "QUICK") => ({
    percent,
    done,
    total,
    current_section: section,
    current_question_key: null,
    current_step: 0,
    fill_mode: fillMode,
    submitted_at: submitted,
    updated_at: now,
  });

  const user = {
    display_name: "Mariana Costa",
    username: "mariana.horizonte",
    client_name: "Imobiliária Horizonte",
    must_change_password: false,
  };

  const productQuestions = [
    { question_key: "product.type", section_name: "Sobre o produto", position: 1, label: "Que tipo de produto é este?", input_type: "SELECT", options: ["Apartamento", "Casa", "Lote", "Comercial"], required: true, help_what: "Defina o tipo principal do imóvel que será anunciado.", help_why: "Isso organiza o restante do briefing.", example_text: "Apartamento residencial." },
    { question_key: "product.location", section_name: "Localização", position: 1, label: "Onde fica o produto?", input_type: "TEXT", required: true, help_what: "Informe bairro, cidade e estado.", help_why: "Localização muda público, mídia e mensagem.", example_text: "Jardim Aquarius · São José dos Campos/SP." },
    { question_key: "product.price", section_name: "Características", position: 1, label: "Qual é a faixa de preço?", input_type: "TEXT", required: true, help_what: "Use o preço ou faixa comercial válida hoje.", help_why: "Ajuda a calibrar público e comunicação." },
    { question_key: "product.configuration", section_name: "Características", position: 2, label: "Como é a configuração?", input_type: "TEXTAREA", required: true, help_what: "Quartos, suítes, vagas, metragem e pontos objetivos." },
    { question_key: "product.differentials", section_name: "Características", position: 3, label: "Quais são os principais diferenciais?", input_type: "TEXTAREA", required: true, allow_unknown: true, help_what: "O que faz este produto ser escolhido em vez de alternativas parecidas?", help_why: "Isso vira matéria-prima para estratégia e criativos." },
    { question_key: "product.availability", section_name: "Disponibilidade", position: 1, label: "O produto está disponível para venda agora?", input_type: "BOOLEAN", required: true },
    { question_key: "product.buy_reason", section_name: "Estratégia", position: 1, label: "Por que alguém compraria este produto?", input_type: "TEXTAREA", required: true, allow_unknown: true, help_what: "Pense no ganho prático, emocional ou patrimonial." },
    { question_key: "product.special_offer", section_name: "Oferta e condições", position: 1, label: "Existe alguma condição comercial ativa?", input_type: "TEXTAREA", required: false, help_what: "Registre somente condições realmente válidas." },
    { question_key: "product.notes", section_name: "Complemento", position: 1, label: "Algo importante ficou de fora?", input_type: "TEXTAREA", required: false },
  ];

  const personaQuestions = [
    { question_key: "persona.intent", section_name: "Quem compra", position: 1, label: "Qual é a principal intenção deste público?", input_type: "SELECT", options: ["Moradia", "Investimento", "Segunda moradia"], required: true },
    { question_key: "persona.age_range", section_name: "Perfil", position: 1, label: "Qual faixa etária faz mais sentido?", input_type: "TEXT", required: true },
    { question_key: "persona.income_range", section_name: "Perfil", position: 2, label: "Qual faixa de renda familiar?", input_type: "TEXT", required: true },
    { question_key: "persona.location", section_name: "De onde vem", position: 1, label: "De quais regiões esse público costuma vir?", input_type: "TEXTAREA", required: true },
    { question_key: "persona.desires", section_name: "Decisão", position: 1, label: "O que essa pessoa mais deseja?", input_type: "TEXTAREA", required: true, allow_unknown: true },
    { question_key: "persona.objections", section_name: "Decisão", position: 2, label: "O que costuma travar a decisão?", input_type: "TEXTAREA", required: true, allow_unknown: true },
    { question_key: "persona.notes", section_name: "Complemento", position: 1, label: "Há algum detalhe adicional relevante?", input_type: "TEXTAREA", required: false },
  ];

  const overview = {
    products: [
      { id: "prod_aurora", name: "Residencial Aurora", status: "IN_PROGRESS", updated_at: "2026-09-02T14:28:00.000Z", personas: [{ id: "persona_upgrade", name: "Casal em fase de upgrade" }], progress: progressOf(62, 8, 13, "Estratégia") },
      { id: "prod_vista", name: "Vista Parque Residence", status: "COMPLETE", updated_at: "2026-08-29T17:10:00.000Z", personas: [{ id: "persona_invest", name: "Investidor patrimonial" }], progress: progressOf(100, 12, 12, "Complemento", "2026-08-29T17:10:00.000Z") },
    ],
    personas: [
      { id: "persona_upgrade", name: "Casal em fase de upgrade", status: "COMPLETE", intent: "Moradia", product_count: 1, updated_at: "2026-08-30T13:00:00.000Z", progress: progressOf(100, 10, 10, "Decisão", "2026-08-30T13:00:00.000Z") },
      { id: "persona_invest", name: "Investidor patrimonial", status: "IN_PROGRESS", intent: "Investimento", product_count: 1, updated_at: "2026-08-28T12:00:00.000Z", progress: progressOf(45, 5, 11, "Perfil") },
    ],
  };

  const entities = {
    "PRODUCT:prod_aurora": {
      entity: { id: "prod_aurora", name: "Residencial Aurora", status: "IN_PROGRESS" },
      questions: productQuestions,
      answers: {
        "product.type": { value: "Apartamento" },
        "product.location": { value: "Jardim Aquarius · São José dos Campos/SP" },
        "product.price": { value: "A partir de R$ 890.000,00" },
        "product.configuration": { value: "92 a 118 m² · 3 dormitórios · 1 suíte · 2 vagas" },
        "product.differentials": { value: "Varanda gourmet, lazer completo e localização consolidada." },
        "product.availability": { value: "Sim" },
        "product.buy_reason": { value: "" },
        "product.special_offer": { value: "" },
        "product.notes": { value: "" },
      },
      links: [{ id: "persona_upgrade", name: "Casal em fase de upgrade", status: "COMPLETE" }],
    },
    "PRODUCT:prod_vista": {
      entity: { id: "prod_vista", name: "Vista Parque Residence", status: "COMPLETE" },
      questions: productQuestions,
      answers: {
        "product.type": { value: "Apartamento" },
        "product.location": { value: "Vila Ema · São José dos Campos/SP" },
        "product.price": { value: "R$ 1.290.000,00" },
        "product.configuration": { value: "108 m² · 3 dormitórios · 1 suíte · 2 vagas" },
        "product.differentials": { value: "Planta funcional, varanda gourmet e condomínio completo." },
        "product.availability": { value: "Sim" },
        "product.buy_reason": { value: "Upgrade de moradia com localização central e patrimônio sólido." },
        "product.special_offer": { value: "Condição sob consulta com a equipe comercial." },
        "product.notes": { value: "Priorizar comunicação sofisticada e objetiva." },
      },
      links: [{ id: "persona_invest", name: "Investidor patrimonial", status: "IN_PROGRESS" }],
    },
    "PERSONA:persona_upgrade": {
      entity: { id: "persona_upgrade", name: "Casal em fase de upgrade", status: "COMPLETE" },
      questions: personaQuestions,
      answers: {
        "persona.intent": { value: "Moradia" },
        "persona.age_range": { value: "30 a 45 anos" },
        "persona.income_range": { value: "Acima de R$ 18 mil/mês" },
        "persona.location": { value: "São José dos Campos e cidades próximas" },
        "persona.desires": { value: "Mais espaço, segurança, boa localização e valorização patrimonial." },
        "persona.objections": { value: "Entrada alta, financiamento e comparação com imóveis usados maiores." },
        "persona.notes": { value: "Normalmente já mora em imóvel menor e está em fase de upgrade." },
      },
      links: [],
    },
    "PERSONA:persona_invest": {
      entity: { id: "persona_invest", name: "Investidor patrimonial", status: "IN_PROGRESS" },
      questions: personaQuestions,
      answers: {
        "persona.intent": { value: "Investimento" },
        "persona.age_range": { value: "35 a 55 anos" },
        "persona.income_range": { value: "Acima de R$ 25 mil/mês" },
        "persona.location": { value: "Vale do Paraíba e Grande São Paulo" },
        "persona.desires": { value: "Valorização patrimonial e liquidez." },
        "persona.objections": { value: "" },
        "persona.notes": { value: "" },
      },
      links: [],
    },
  };

  const progress = {
    "PRODUCT:prod_aurora": { progress: overview.products[0].progress, stats: { done: 8, total: 13, percent: 62 }, flags: [] },
    "PRODUCT:prod_vista": { progress: overview.products[1].progress, stats: { done: 12, total: 12, percent: 100 }, flags: [] },
    "PERSONA:persona_upgrade": { progress: overview.personas[0].progress, stats: { done: 10, total: 10, percent: 100 }, flags: [] },
    "PERSONA:persona_invest": { progress: overview.personas[1].progress, stats: { done: 5, total: 11, percent: 45 }, flags: [] },
  };

  const histories = {
    "PRODUCT:prod_aurora": [
      { question_key: "product.differentials", label: "Principais diferenciais", old_value: "Lazer completo", new_value: "Varanda gourmet, lazer completo e localização consolidada.", changed_at: "2026-09-02T13:42:00.000Z", changed_by_name: "Mariana Costa" },
      { question_key: "product.price", label: "Faixa de preço", old_value: "A partir de R$ 850.000,00", new_value: "A partir de R$ 890.000,00", changed_at: "2026-09-01T18:16:00.000Z", changed_by_name: "Mariana Costa" },
    ],
    "PRODUCT:prod_vista": [{ question_key: "product.special_offer", label: "Condição comercial", old_value: "", new_value: "Condição sob consulta com a equipe comercial.", changed_at: "2026-08-29T17:08:00.000Z", changed_by_name: "Mariana Costa" }],
    "PERSONA:persona_upgrade": [{ question_key: "persona.objections", label: "Objeções", old_value: "Preço", new_value: "Entrada alta, financiamento e comparação com imóveis usados maiores.", changed_at: "2026-08-30T12:55:00.000Z", changed_by_name: "Mariana Costa" }],
    "PERSONA:persona_invest": [{ question_key: "persona.desires", label: "Desejos", old_value: "Valorização", new_value: "Valorização patrimonial e liquidez.", changed_at: "2026-08-28T11:48:00.000Z", changed_by_name: "Mariana Costa" }],
  };

  const account = {
    client: { id: "demo-client", name: "Imobiliária Horizonte" },
    questions: [
      { question_key: "brand.positioning", section_name: "Marca", position: 1, label: "Como você define o posicionamento da sua marca?", input_type: "TEXTAREA", required: false, help_what: "Explique em poucas palavras como quer ser percebido." },
      { question_key: "brand.region", section_name: "Mercado", position: 1, label: "Qual é sua principal região de atuação?", input_type: "TEXT", required: false },
    ],
    answers: {
      "brand.positioning": { value: "Atendimento consultivo para imóveis de médio e alto padrão." },
      "brand.region": { value: "São José dos Campos e Vale do Paraíba" },
    },
  };

  const materials = {
    ready: true,
    folder_name: "Materiais Brutos · Imobiliária Horizonte",
    folder_url: "#presentation-drive",
    files: [
      { file_name: "Logo oficial.svg", path: "Identidade visual", size_bytes: 248320, modified_at: "2026-09-01T16:10:00.000Z", web_url: "#presentation-file" },
      { file_name: "Fachada - Residencial Aurora.jpg", path: "Fotos / Residencial Aurora", size_bytes: 4823440, modified_at: "2026-09-01T15:54:00.000Z", web_url: "#presentation-file" },
      { file_name: "Vídeo decorado.mp4", path: "Vídeos / Residencial Aurora", size_bytes: 38742112, modified_at: "2026-08-31T19:20:00.000Z", web_url: "#presentation-file" },
      { file_name: "Apresentação comercial.pdf", path: "Materiais comerciais", size_bytes: 7341056, modified_at: "2026-08-30T12:14:00.000Z", web_url: "#presentation-file" },
    ],
  };

  const portal = {
    config: {
      has_crm: true,
      crm_name: "Kommo",
      crm_url: "https://exemplo.invalid/crm",
      crm_login: "comercial@horizonte.com.br",
      crm_password_saved: true,
      lead_phone: "",
    },
  };

  const fileStore = {};
  const nativeFetch = window.fetch.bind(window);

  function toast(message) {
    let el = document.querySelector(".bh-demo-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "bh-demo-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(el._demoTimer);
    el._demoTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function ensureBadge() {
    const foot = document.querySelector(".bh-side-footer");
    if (foot && !document.querySelector(".bh-demo-badge")) {
      const badge = document.createElement("div");
      badge.className = "bh-demo-badge";
      badge.textContent = "Modo apresentação";
      foot.prepend(badge);
    }
  }

  function currentEntity(type, id) {
    return entities[keyFor(type, id)] || null;
  }

  function reviewFor(type, id) {
    const entity = currentEntity(type, id);
    const p = progress[keyFor(type, id)] || { flags: [] };
    if (!entity) return { missing: [], review_flags: [] };
    const flagged = new Set((p.flags || []).map((item) => item.question_key || item));
    const missing = entity.questions
      .filter((q) => q.required === true || q.required === 1)
      .filter((q) => {
        const value = entity.answers[q.question_key] && entity.answers[q.question_key].value;
        const filled = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && String(value).trim() !== "";
        return !filled && !flagged.has(q.question_key);
      })
      .map((q) => ({ question_key: q.question_key, label: q.label }));
    return {
      missing,
      review_flags: Array.from(flagged).map((question_key) => ({ question_key })),
    };
  }

  new MutationObserver(ensureBadge).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("DOMContentLoaded", ensureBadge);

  document.addEventListener("click", (event) => {
    const logout = event.target && event.target.closest && event.target.closest("#out");
    if (logout) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("Modo apresentação: nenhum acesso real será encerrado.");
      return;
    }
    const anchor = event.target && event.target.closest && event.target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (href.startsWith("#presentation") || href.startsWith("/api/client/pdf") || href.startsWith("/api/client/file")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast(href.includes("drive") ? "Modo apresentação: esta seria a pasta oficial do cliente no Google Drive." : "Modo apresentação: arquivo demonstrativo, sem download real.");
    }
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target && event.target.id === "mfile") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target.value = "";
      toast("Modo apresentação: uploads são simulados e nada é enviado ao Drive.");
    }
  }, true);

  window.fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    const url = new URL(raw, location.href);
    const path = url.pathname;
    const method = String(init.method || "GET").toUpperCase();

    if (!path.startsWith("/api/client/")) return nativeFetch(input, init);

    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch {}

    if (path === "/api/client/me") return json({ user: clone(user) });
    if (path === "/api/client/logout") return json({ ok: true });
    if (path === "/api/client/overview") return json(clone(overview));

    if (path === "/api/client/account") {
      if (method === "GET") return json(clone(account));
      if (body.key) account.answers[body.key] = { value: body.value };
      toast("Alteração simulada — nada foi salvo fora desta apresentação.");
      return json({ ok: true });
    }

    if (path === "/api/client/entity") {
      const entity = currentEntity(url.searchParams.get("type"), url.searchParams.get("id"));
      return entity ? json(clone(entity)) : json({ error: "not_found" }, 404);
    }

    if (path === "/api/client/progress") {
      const key = keyFor(url.searchParams.get("type") || body.type, url.searchParams.get("id") || body.id);
      if (method === "PUT") {
        if (!progress[key]) progress[key] = { progress: progressOf(0, 0, 1, "Sobre o produto", null, null), stats: { done: 0, total: 1, percent: 0 }, flags: [] };
        Object.assign(progress[key].progress, body);
        return json({ ok: true, progress: clone(progress[key].progress) });
      }
      return progress[key] ? json(clone(progress[key])) : json({ progress: progressOf(0, 0, 1, "Sobre o produto", null, null), stats: { done: 0, total: 1, percent: 0 }, flags: [] });
    }

    if (path === "/api/client/answer" && method === "PUT") {
      const entity = currentEntity(body.type, body.id);
      if (entity && body.key) entity.answers[body.key] = { value: body.value };
      return json({ ok: true, status: "DRAFT" });
    }

    if (path === "/api/client/review-flag" && method === "PUT") {
      const key = keyFor(body.type, body.id);
      if (!progress[key]) progress[key] = { progress: progressOf(0, 0, 1, "Sobre o produto"), stats: {}, flags: [] };
      const flags = progress[key].flags || (progress[key].flags = []);
      const index = flags.findIndex((item) => (item.question_key || item) === body.key);
      if (body.review_needed && index < 0) flags.push({ question_key: body.key });
      if (!body.review_needed && index >= 0) flags.splice(index, 1);
      return json({ ok: true });
    }

    if (path === "/api/client/review") {
      return json(reviewFor(url.searchParams.get("type"), url.searchParams.get("id")));
    }

    if (path === "/api/client/submit" && method === "POST") {
      const key = keyFor(body.type, body.id);
      const check = reviewFor(body.type, body.id);
      if (check.missing.length) return json({ error: "missing_required" }, 400);
      const submittedAt = new Date().toISOString();
      if (progress[key]) progress[key].progress.submitted_at = submittedAt;
      toast("Envio simulado — nenhum briefing real foi enviado.");
      return json({ ok: true, submitted_at: submittedAt });
    }

    if (path === "/api/client/files") {
      const key = keyFor(url.searchParams.get("type") || body.type, url.searchParams.get("id") || body.id);
      if (method === "GET") return json({ files: clone(fileStore[key] || []) });
      if (method === "POST") {
        const file = { id: "demo-file-" + Date.now(), question_key: body.key, file_name: body.file_name || "Arquivo", size_bytes: Number(body.size_bytes || 0), created_at: new Date().toISOString() };
        (fileStore[key] || (fileStore[key] = [])).unshift(file);
        toast("Arquivo anexado somente nesta apresentação.");
        return json({ file: clone(file) });
      }
      if (method === "DELETE") {
        const fid = url.searchParams.get("file_id");
        Object.keys(fileStore).forEach((k) => { fileStore[k] = fileStore[k].filter((f) => f.id !== fid); });
        return json({ ok: true });
      }
    }

    if (path === "/api/client/history") {
      const key = keyFor(url.searchParams.get("type"), url.searchParams.get("id"));
      return json({ history: clone(histories[key] || []) });
    }

    if (path === "/api/client/materials") return json(clone(materials));

    if (path === "/api/client/portal-config") {
      if (method === "PUT") {
        Object.assign(portal.config, body);
        portal.config.crm_password_saved = portal.config.crm_password_saved || Boolean(body.crm_password);
        toast("Integração simulada — nenhuma credencial real foi alterada.");
      }
      return json(clone(portal));
    }

    if (path === "/api/client/products" && method === "POST") {
      const id = "demo-product-" + Date.now();
      const name = String(body.name || "Novo produto demonstrativo");
      const p = progressOf(0, 0, productQuestions.length, "Sobre o produto", null, null);
      overview.products.unshift({ id, name, status: "IN_PROGRESS", updated_at: new Date().toISOString(), personas: [], progress: p });
      entities["PRODUCT:" + id] = { entity: { id, name, status: "IN_PROGRESS" }, questions: productQuestions, answers: {}, links: [] };
      progress["PRODUCT:" + id] = { progress: p, stats: { done: 0, total: productQuestions.length, percent: 0 }, flags: [] };
      histories["PRODUCT:" + id] = [];
      toast("Produto criado apenas nesta apresentação.");
      return json({ id });
    }

    if (path === "/api/client/personas" && method === "POST") {
      const id = "demo-persona-" + Date.now();
      const name = String(body.name || "Nova persona demonstrativa");
      const p = progressOf(0, 0, personaQuestions.length, "Quem compra", null, null);
      overview.personas.unshift({ id, name, status: "IN_PROGRESS", intent: "", product_count: 0, updated_at: new Date().toISOString(), progress: p });
      entities["PERSONA:" + id] = { entity: { id, name, status: "IN_PROGRESS" }, questions: personaQuestions, answers: {}, links: [] };
      progress["PERSONA:" + id] = { progress: p, stats: { done: 0, total: personaQuestions.length, percent: 0 }, flags: [] };
      histories["PERSONA:" + id] = [];
      toast("Persona criada apenas nesta apresentação.");
      return json({ id });
    }

    if (path === "/api/client/duplicate-persona" && method === "POST") {
      const source = entities["PERSONA:" + body.persona_id] || entities["PERSONA:persona_upgrade"];
      const id = "demo-persona-copy-" + Date.now();
      const name = String(body.name || "Persona — variação");
      const copy = clone(source);
      copy.entity = { id, name, status: "IN_PROGRESS" };
      entities["PERSONA:" + id] = copy;
      const p = progressOf(0, 0, personaQuestions.length, "Quem compra");
      overview.personas.unshift({ id, name, status: "IN_PROGRESS", intent: "", product_count: 0, updated_at: new Date().toISOString(), progress: p });
      progress["PERSONA:" + id] = { progress: p, stats: { done: 0, total: personaQuestions.length, percent: 0 }, flags: [] };
      histories["PERSONA:" + id] = [];
      toast("Cópia criada apenas nesta apresentação.");
      return json({ id });
    }

    if (path === "/api/client/link-persona" && method === "POST") {
      const product = overview.products.find((item) => item.id === body.product_id);
      const persona = overview.personas.find((item) => item.id === body.persona_id);
      if (product && persona && !product.personas.some((item) => item.id === persona.id)) {
        product.personas.push({ id: persona.id, name: persona.name });
        persona.product_count = Number(persona.product_count || 0) + 1;
      }
      toast("Vínculo simulado apenas nesta apresentação.");
      return json({ ok: true });
    }

    if (path === "/api/client/context") {
      if (method === "GET") return json({ x: {} });
      toast("Contexto salvo apenas nesta apresentação.");
      return json({ ok: true });
    }

    if (path === "/api/client/requests") {
      if (method === "GET") return json({ requests: [] });
      toast("Solicitação simulada — nada foi enviado à agência.");
      return json({ ok: true, id: "demo-request" });
    }

    if (path === "/api/client/approvals") {
      if (method === "GET") return json({ approvals: [] });
      toast("Aprovação simulada — nenhum material real foi alterado.");
      return json({ ok: true });
    }

    if (path === "/api/client/materials/upload-start") return json({ upload_id: "presentation-upload" });

    if (method !== "GET") {
      toast("Ação simulada — nenhuma informação real foi alterada.");
      return json({ ok: true, status: "DRAFT", id: "demo-" + Date.now() });
    }

    return json({ ok: true });
  };
})();
`;

const DEMO_STYLE = String.raw`
<style>
.bh-demo-badge{margin:0 0 10px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--accent) 55%,var(--line));border-radius:9px;background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--accent);font-size:9px;font-weight:900;letter-spacing:.11em;text-align:center;text-transform:uppercase}
.bh-demo-toast{position:fixed;right:18px;bottom:18px;z-index:9999;max-width:360px;padding:11px 13px;border:1px solid var(--line);border-radius:11px;background:var(--panel);color:var(--text);box-shadow:var(--shadow);font-size:11px;line-height:1.45;opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s}.bh-demo-toast.show{opacity:1;transform:none}
</style>
`;

function injectPresentationMode(html: string): string {
  const title = html.replace(/<title>Briefing Hub<\/title>/i, "<title>Briefing Hub · Modo apresentação</title>");
  const payload = `${DEMO_STYLE}<script>${DEMO_SCRIPT}</script>`;
  if (/<body[^>]*>/i.test(title)) {
    return title.replace(/<body[^>]*>/i, (match) => `${match}${payload}`);
  }
  return title.replace(/<\/head>/i, `${payload}</head>`);
}

export async function GET(): Promise<Response> {
  try {
    const upstream = await fetch(PRIMARY_HUB, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      cache: "no-store",
      redirect: "follow",
    });

    if (!upstream.ok) {
      return new Response("Briefing Hub presentation source unavailable", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const html = injectPresentationMode(await upstream.text());
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch {
    return new Response("Briefing Hub presentation source unavailable", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
