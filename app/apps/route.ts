const APPS = [
  {
    id: "dashboard",
    nome: "Dashboard Operacional",
    tipo: "Sistema interno",
    descricao: "Central da operação, clientes, alertas e rotinas da equipe.",
    href: "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/",
    icone: "OP",
    iconHref: "",
  },
  {
    id: "briefing",
    nome: "Briefing Hub",
    tipo: "Portal do cliente",
    descricao: "Produtos, personas, briefings e materiais do onboarding.",
    href: "https://agency-briefing-hub.lakassessoriadigital.workers.dev/cliente",
    icone: "BH",
    iconHref: "/brand/briefing-hub-icon.svg",
  },
  {
    id: "imobiboard",
    nome: "ImobiBoard",
    tipo: "CRM imobiliário",
    descricao: "Leads, pipeline e rotina comercial da imobiliária.",
    href: "https://imobi-board-app.lakassessoriadigital.workers.dev/",
    icone: "IB",
    iconHref: "/brand/imobi-board-icon.svg",
  },
  {
    id: "briefing-demo",
    nome: "Briefing Hub · Demo",
    tipo: "Demonstração",
    descricao: "Ambiente fictício para apresentar o Briefing Hub sem tocar dados reais.",
    href: "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/briefing-hub-demo",
    icone: "BH",
    iconHref: "/brand/briefing-hub-icon.svg",
  },
  {
    id: "imobiboard-demo",
    nome: "ImobiBoard · Demo",
    tipo: "Demonstração",
    descricao: "Ambiente fictício do CRM para apresentações e testes.",
    href: "https://imobi-board-app.lakassessoriadigital.workers.dev/#/demo",
    icone: "IB",
    iconHref: "/brand/imobi-board-icon.svg",
  },
];

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pagina() {
  const cards = APPS.map((app) => {
    const icon = app.iconHref
      ? `<img src="${esc(app.iconHref)}" alt="" width="42" height="42">`
      : `<span class="fallback-icon">${esc(app.icone)}</span>`;
    return `
      <article class="app-card" data-app="${esc(app.id)}">
        <div class="app-head">
          <div class="app-icon">${icon}</div>
          <div class="app-title">
            <span class="app-type">${esc(app.tipo)}</span>
            <h2>${esc(app.nome)}</h2>
          </div>
        </div>
        <p>${esc(app.descricao)}</p>
        <div class="actions">
          <a class="btn primary" href="${esc(app.href)}" rel="noopener">Abrir sistema</a>
          <button class="btn secondary" type="button" data-install-name="${esc(app.nome)}" data-install-url="${esc(app.href)}">Adicionar ao iPhone</button>
        </div>
      </article>`;
  }).join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#071C3D">
<title>Apps Lak · Instalar no iPhone</title>
<style>
  :root{color-scheme:dark;--bg:#040914;--panel:#08162c;--panel2:#0a1c38;--line:#17345f;--text:#f4f7fb;--muted:#90a3bc;--blue:#0c63b9;--orange:#fd6801;--ok:#36d399}
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% 0%,rgba(3,84,155,.28),transparent 35%),var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"SF Pro Text","Segoe UI",sans-serif}
  button,a{font:inherit}
  .shell{width:min(960px,100%);margin:0 auto;padding:max(30px,env(safe-area-inset-top)) 18px max(46px,env(safe-area-inset-bottom))}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;color:#a9bdd8;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .eyebrow::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--orange);box-shadow:0 0 18px rgba(253,104,1,.65)}
  h1{font-size:clamp(32px,7vw,56px);line-height:1.02;letter-spacing:-.04em;margin:12px 0 12px;max-width:760px}
  .lead{margin:0;max-width:700px;color:var(--muted);font-size:16px}
  .hero-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
  .share-central{border:1px solid var(--line);background:rgba(8,22,44,.75);color:var(--text);padding:10px 14px;border-radius:11px;cursor:pointer}
  .share-central:active{transform:translateY(1px)}
  .tip{margin:24px 0 18px;border:1px solid rgba(12,99,185,.45);background:rgba(3,84,155,.11);border-radius:14px;padding:13px 15px;color:#c9d7ea;font-size:13px}
  .tip strong{color:#fff}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .app-card{background:linear-gradient(180deg,rgba(10,28,56,.96),rgba(7,20,40,.96));border:1px solid var(--line);border-radius:20px;padding:18px;box-shadow:0 18px 45px rgba(0,0,0,.16)}
  .app-head{display:flex;align-items:center;gap:13px}
  .app-icon{width:58px;height:58px;flex:0 0 58px;border-radius:16px;background:#071c3d;border:1px solid #21456f;display:grid;place-items:center;overflow:hidden}
  .app-icon img{width:42px;height:42px;object-fit:contain}
  .fallback-icon{font-weight:800;letter-spacing:-.04em;font-size:19px;color:#fff}
  .app-type{display:block;color:#7ea6d6;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
  h2{font-size:18px;margin:0;letter-spacing:-.02em}
  .app-card p{color:var(--muted);min-height:45px;margin:14px 0 16px;font-size:13px}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;justify-content:center;border-radius:11px;padding:10px 13px;text-decoration:none;border:1px solid transparent;cursor:pointer;font-weight:700;font-size:13px;min-height:42px}
  .primary{background:var(--orange);color:white}
  .secondary{background:transparent;color:#dce8f7;border-color:var(--line)}
  .primary:hover{filter:brightness(1.06)}
  .secondary:hover{border-color:#2d5b91;background:rgba(3,84,155,.08)}
  .foot{margin-top:22px;color:#687f9f;font-size:12px;text-align:center}
  dialog{width:min(520px,calc(100% - 28px));border:1px solid #294f7f;border-radius:22px;background:#071528;color:var(--text);padding:0;box-shadow:0 30px 100px rgba(0,0,0,.6)}
  dialog::backdrop{background:rgba(0,0,0,.7);backdrop-filter:blur(4px)}
  .modal{padding:20px}
  .modal-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
  .modal h3{font-size:22px;margin:0 0 5px;letter-spacing:-.025em}
  .modal .sub{color:var(--muted);font-size:13px;margin:0}
  .close{border:1px solid var(--line);background:transparent;color:#c9d8eb;border-radius:9px;width:36px;height:36px;cursor:pointer}
  .steps{display:grid;gap:10px;margin:18px 0}
  .step{display:grid;grid-template-columns:30px 1fr;gap:10px;align-items:start;background:#0a1c36;border:1px solid #18375f;border-radius:13px;padding:11px}
  .n{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#0b5da8;color:white;font-size:12px;font-weight:800}
  .step b{display:block;font-size:13px;margin-bottom:2px}.step span{color:var(--muted);font-size:12px}
  .modal-actions{display:flex;gap:8px;flex-wrap:wrap}
  .modal-actions .btn{flex:1 1 170px}
  .status{margin-top:10px;color:var(--ok);font-size:12px;min-height:18px}
  .non-safari{display:none;margin:12px 0 0;border:1px solid rgba(253,104,1,.45);background:rgba(253,104,1,.08);color:#ffd8bc;border-radius:11px;padding:10px 11px;font-size:12px}
  @media(max-width:700px){.grid{grid-template-columns:1fr}.app-card p{min-height:0}.shell{padding-left:14px;padding-right:14px}.actions .btn{flex:1 1 150px}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<main class="shell">
  <span class="eyebrow">Lak Assessoria Digital</span>
  <h1>Seus sistemas no iPhone, como apps.</h1>
  <p class="lead">Abra esta página no iPhone, escolha o sistema e siga o passo a passo. O ícone fica na Tela de Início e abre direto no sistema.</p>
  <div class="hero-actions">
    <button id="share-central" class="share-central" type="button">Compartilhar esta central</button>
  </div>
  <div class="tip"><strong>Importante:</strong> o iPhone exige uma confirmação do usuário para colocar um site na Tela de Início. Esta página reduz o processo ao mínimo e mostra exatamente onde tocar.</div>
  <section class="grid">${cards}</section>
  <p class="foot">Central pública de atalhos. Nenhuma credencial ou dado de cliente é armazenado aqui.</p>
</main>
<dialog id="install-dialog">
  <div class="modal">
    <div class="modal-top"><div><h3 id="install-title">Adicionar ao iPhone</h3><p class="sub" id="install-url"></p></div><button class="close" type="button" aria-label="Fechar">✕</button></div>
    <div class="non-safari" id="non-safari">Você parece estar dentro de outro aplicativo. Abra o endereço no <strong>Safari</strong> antes de continuar.</div>
    <div class="steps">
      <div class="step"><div class="n">1</div><div><b>Abra o sistema no Safari</b><span>Use o botão abaixo para abrir o endereço correto.</span></div></div>
      <div class="step"><div class="n">2</div><div><b>Toque em Compartilhar</b><span>É o ícone do quadrado com uma seta para cima na barra do Safari.</span></div></div>
      <div class="step"><div class="n">3</div><div><b>Adicionar à Tela de Início</b><span>Escolha essa opção; se aparecer “Abrir como App da Web”, deixe ativado.</span></div></div>
      <div class="step"><div class="n">4</div><div><b>Toque em Adicionar</b><span>Pronto: o sistema vira um ícone na Tela de Início.</span></div></div>
    </div>
    <div class="modal-actions">
      <a class="btn primary" id="open-app" href="#">Abrir sistema</a>
      <button class="btn secondary" id="copy-app" type="button">Copiar link</button>
    </div>
    <div class="status" id="status"></div>
  </div>
</dialog>
<script>
(() => {
  const dialog = document.getElementById('install-dialog');
  const title = document.getElementById('install-title');
  const urlEl = document.getElementById('install-url');
  const open = document.getElementById('open-app');
  const copy = document.getElementById('copy-app');
  const status = document.getElementById('status');
  const nonSafari = document.getElementById('non-safari');
  let currentUrl = '';

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

  document.querySelectorAll('[data-install-url]').forEach((button) => {
    button.addEventListener('click', () => {
      currentUrl = button.getAttribute('data-install-url') || '';
      const name = button.getAttribute('data-install-name') || 'este sistema';
      title.textContent = 'Adicionar ' + name + ' ao iPhone';
      urlEl.textContent = currentUrl;
      open.href = currentUrl;
      status.textContent = '';
      nonSafari.style.display = isIOS && !isSafari ? 'block' : 'none';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  });

  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      status.textContent = 'Link copiado.';
    } catch (_) {
      status.textContent = 'Selecione e copie o endereço acima.';
    }
  });

  document.getElementById('share-central').addEventListener('click', async () => {
    const data = { title: 'Apps Lak', text: 'Acesse e instale os sistemas da Lak no iPhone.', url: location.href };
    if (navigator.share) {
      try { await navigator.share(data); } catch (_) {}
      return;
    }
    try {
      await navigator.clipboard.writeText(location.href);
      alert('Link da central copiado.');
    } catch (_) {
      alert(location.href);
    }
  });
})();
</script>
</body>
</html>`;
}

export async function GET(): Promise<Response> {
  return new Response(pagina(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
