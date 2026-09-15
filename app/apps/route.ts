/**
 * Pagina de instalacao dos apps no celular.
 *
 * ATENCAO -- esta pagina existia APENAS dentro do worker publicado. Foi ao ar
 * em 05/09/2026 e nunca chegou ao git, entao um `wrangler deploy` feito a
 * partir do repositorio a apagava do ar sem aviso -- foi exatamente o que
 * aconteceu em 06/09. O HTML abaixo foi recuperado da versao publicada
 * (4a970c64) e recolocado aqui para que isso nao se repita.
 *
 * Cabecalhos iguais aos que a versao publicada devolvia: cache de 5 minutos e
 * noindex. A CSP vem do middleware do worker, nao daqui.
 */

const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#071C3D">
<title>Apps Leonardo Imobi · Instalar no celular</title>
<style>
  :root{color-scheme:dark;--bg:#040914;--panel:#08162c;--panel2:#0a1c38;--line:#17345f;--text:#f4f7fb;--muted:#90a3bc;--blue:#0c63b9;--orange:#fd6801;--ok:#36d399}
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% 0%,rgba(3,84,155,.28),transparent 35%),var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"SF Pro Text","Segoe UI",sans-serif}
  button,a{font:inherit}
  .shell{width:min(960px,100%);margin:0 auto;padding:max(30px,env(safe-area-inset-top)) 18px max(46px,env(safe-area-inset-bottom))}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
  .brand-mark{width:28px;height:40px;color:#fff;flex:0 0 auto}
  .brand-mark svg{display:block;width:100%;height:100%}
  .brand-name{font-weight:800;letter-spacing:-.02em;font-size:16px}
  .brand-name small{display:block;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-top:1px}
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
  .modal .sub{color:var(--muted);font-size:13px;margin:0;word-break:break-all}
  .close{border:1px solid var(--line);background:transparent;color:#c9d8eb;border-radius:9px;width:36px;height:36px;cursor:pointer}
  .steps{display:grid;gap:10px;margin:18px 0}
  .step{display:grid;grid-template-columns:30px 1fr;gap:10px;align-items:start;background:#0a1c36;border:1px solid #18375f;border-radius:13px;padding:11px}
  .n{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#0b5da8;color:white;font-size:12px;font-weight:800}
  .step b{display:block;font-size:13px;margin-bottom:2px}.step span{color:var(--muted);font-size:12px}
  .modal-actions{display:flex;gap:8px;flex-wrap:wrap}
  .modal-actions .btn{flex:1 1 170px}
  .status{margin-top:10px;color:var(--ok);font-size:12px;min-height:18px}
  .browser-warning{display:none;margin:12px 0 0;border:1px solid rgba(253,104,1,.45);background:rgba(253,104,1,.08);color:#ffd8bc;border-radius:11px;padding:10px 11px;font-size:12px}
  @media(max-width:700px){.grid{grid-template-columns:1fr}.app-card p{min-height:0}.shell{padding-left:14px;padding-right:14px}.actions .btn{flex:1 1 150px}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<main class="shell">
  <div class="brand"><div class="brand-mark"><svg viewBox="0 0 276 390" role="img" aria-label="Leonardo Imobi" fill="none">
  <rect x="6.5" y="6.5" width="263" height="252" stroke="currentColor" stroke-width="13" />
  <rect x="0" y="252" width="13" height="138" fill="currentColor" />
  <polygon points="68,223 276,247 276,253 68,253" fill="currentColor" />
  <polygon points="0,377 208,343 208,390 0,390" fill="currentColor" />
</svg></div><div class="brand-name">Leonardo Imobi<small>Ecossistema de sistemas</small></div></div>
  <span class="eyebrow">Apps Leonardo Imobi</span>
  <h1>Seus sistemas no celular, como apps.</h1>
  <p class="lead">Abra esta página no iPhone ou Android, escolha o sistema e siga o passo a passo. O ícone fica na Tela de Início e abre direto no sistema.</p>
  <div class="hero-actions">
    <button id="share-central" class="share-central" type="button">Compartilhar esta central</button>
  </div>
  <div class="tip"><strong>Importante:</strong> iPhone e Android exigem uma confirmação do usuário para instalar ou colocar um site na Tela de Início. Esta página detecta o aparelho e mostra o caminho mais curto.</div>
  <section class="grid">
      <article class="app-card" data-app="dashboard">
        <div class="app-head">
          <div class="app-icon"><span class="fallback-icon">OP</span></div>
          <div class="app-title">
            <span class="app-type">Sistema interno</span>
            <h2>Dashboard Operacional</h2>
          </div>
        </div>
        <p>Central da operação, clientes, alertas e rotinas da equipe.</p>
        <div class="actions">
          <a class="btn primary" href="https://agency-ops-dashboard.lakassessoriadigital.workers.dev/" rel="noopener">Abrir sistema</a>
          <button class="btn secondary" type="button" data-install-name="Dashboard Operacional" data-install-url="https://agency-ops-dashboard.lakassessoriadigital.workers.dev/">Adicionar ao celular</button>
        </div>
      </article>
      <article class="app-card" data-app="briefing">
        <div class="app-head">
          <div class="app-icon"><img src="/brand/briefing-hub-icon.svg" alt="" width="42" height="42"></div>
          <div class="app-title">
            <span class="app-type">Portal do cliente</span>
            <h2>Briefing Hub</h2>
          </div>
        </div>
        <p>Produtos, personas, briefings e materiais do onboarding.</p>
        <div class="actions">
          <a class="btn primary" href="https://agency-briefing-hub.lakassessoriadigital.workers.dev/cliente" rel="noopener">Abrir sistema</a>
          <button class="btn secondary" type="button" data-install-name="Briefing Hub" data-install-url="https://agency-briefing-hub.lakassessoriadigital.workers.dev/cliente">Adicionar ao celular</button>
        </div>
      </article>
      <article class="app-card" data-app="imobiboard">
        <div class="app-head">
          <div class="app-icon"><img src="/brand/imobi-board-icon.svg" alt="" width="42" height="42"></div>
          <div class="app-title">
            <span class="app-type">CRM imobiliário</span>
            <h2>ImobiBoard</h2>
          </div>
        </div>
        <p>Leads, pipeline e rotina comercial da imobiliária.</p>
        <div class="actions">
          <a class="btn primary" href="https://imobi-board-app.lakassessoriadigital.workers.dev/" rel="noopener">Abrir sistema</a>
          <button class="btn secondary" type="button" data-install-name="ImobiBoard" data-install-url="https://imobi-board-app.lakassessoriadigital.workers.dev/">Adicionar ao celular</button>
        </div>
      </article>
      <article class="app-card" data-app="briefing-demo">
        <div class="app-head">
          <div class="app-icon"><img src="/brand/briefing-hub-icon.svg" alt="" width="42" height="42"></div>
          <div class="app-title">
            <span class="app-type">Demonstração</span>
            <h2>Briefing Hub · Demo</h2>
          </div>
        </div>
        <p>Ambiente fictício para apresentar o Briefing Hub sem tocar dados reais.</p>
        <div class="actions">
          <a class="btn primary" href="https://agency-ops-dashboard.lakassessoriadigital.workers.dev/briefing-hub-demo" rel="noopener">Abrir sistema</a>
          <button class="btn secondary" type="button" data-install-name="Briefing Hub · Demo" data-install-url="https://agency-ops-dashboard.lakassessoriadigital.workers.dev/briefing-hub-demo">Adicionar ao celular</button>
        </div>
      </article>
      <article class="app-card" data-app="imobiboard-demo">
        <div class="app-head">
          <div class="app-icon"><img src="/brand/imobi-board-icon.svg" alt="" width="42" height="42"></div>
          <div class="app-title">
            <span class="app-type">Demonstração</span>
            <h2>ImobiBoard · Demo</h2>
          </div>
        </div>
        <p>Ambiente fictício do CRM para apresentações e testes.</p>
        <div class="actions">
          <a class="btn primary" href="https://imobi-board-app.lakassessoriadigital.workers.dev/#/demo" rel="noopener">Abrir sistema</a>
          <button class="btn secondary" type="button" data-install-name="ImobiBoard · Demo" data-install-url="https://imobi-board-app.lakassessoriadigital.workers.dev/#/demo">Adicionar ao celular</button>
        </div>
      </article></section>
  <p class="foot">Leonardo Imobi · Central pública de atalhos. Nenhuma credencial ou dado de cliente é armazenado aqui.</p>
</main>
<dialog id="install-dialog">
  <div class="modal">
    <div class="modal-top"><div><h3 id="install-title">Adicionar ao celular</h3><p class="sub" id="install-url"></p></div><button class="close" type="button" aria-label="Fechar">✕</button></div>
    <div class="browser-warning" id="browser-warning"></div>
    <div class="steps" id="steps"></div>
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
  const warning = document.getElementById('browser-warning');
  const steps = document.getElementById('steps');
  let currentUrl = '';

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isChromeAndroid = isAndroid && /Chrome//.test(ua) && !/EdgA|OPR//.test(ua);

  function renderSteps() {
    warning.style.display = 'none';
    if (isIOS) {
      title.textContent = title.textContent.replace('ao celular', 'ao iPhone');
      if (!isSafari) {
        warning.innerHTML = 'Abra este endereço no <strong>Safari</strong> para ter a opção de adicionar como app.';
        warning.style.display = 'block';
      }
      steps.innerHTML = '<div class="step"><div class="n">1</div><div><b>Abra o sistema no Safari</b><span>Use o botão abaixo para abrir o endereço correto.</span></div></div>' +
        '<div class="step"><div class="n">2</div><div><b>Toque em Compartilhar</b><span>É o ícone do quadrado com uma seta para cima.</span></div></div>' +
        '<div class="step"><div class="n">3</div><div><b>Adicionar à Tela de Início</b><span>Se aparecer “Abrir como App da Web”, deixe ativado.</span></div></div>' +
        '<div class="step"><div class="n">4</div><div><b>Toque em Adicionar</b><span>Pronto: o sistema vira um ícone na Tela de Início.</span></div></div>';
      return;
    }
    if (isAndroid) {
      title.textContent = title.textContent.replace('ao celular', 'ao Android');
      if (!isChromeAndroid) {
        warning.innerHTML = 'No Android, o caminho mais consistente é abrir o sistema no <strong>Chrome</strong>.';
        warning.style.display = 'block';
      }
      steps.innerHTML = '<div class="step"><div class="n">1</div><div><b>Abra o sistema no Chrome</b><span>Use o botão abaixo para abrir o endereço correto.</span></div></div>' +
        '<div class="step"><div class="n">2</div><div><b>Abra o menu ⋮</b><span>Toque nos três pontos do Chrome.</span></div></div>' +
        '<div class="step"><div class="n">3</div><div><b>Instalar app ou Adicionar à tela inicial</b><span>O texto pode variar conforme o site e a versão do Chrome.</span></div></div>' +
        '<div class="step"><div class="n">4</div><div><b>Confirme a instalação</b><span>O ícone será criado na tela inicial ou no launcher.</span></div></div>';
      return;
    }
    steps.innerHTML = '<div class="step"><div class="n">1</div><div><b>Abra no celular</b><span>Envie esta central para seu iPhone ou Android.</span></div></div>' +
      '<div class="step"><div class="n">2</div><div><b>Use o navegador do aparelho</b><span>Safari no iPhone ou Chrome no Android.</span></div></div>';
  }

  document.querySelectorAll('[data-install-url]').forEach((button) => {
    button.addEventListener('click', () => {
      currentUrl = button.getAttribute('data-install-url') || '';
      const name = button.getAttribute('data-install-name') || 'este sistema';
      title.textContent = 'Adicionar ' + name + ' ao celular';
      urlEl.textContent = currentUrl;
      open.href = currentUrl;
      status.textContent = '';
      renderSteps();
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
    const data = { title: 'Apps Leonardo Imobi', text: 'Acesse os sistemas da Leonardo Imobi e adicione ao celular.', url: location.href };
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

export async function GET(): Promise<Response> {
  return new Response(PAGINA, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
