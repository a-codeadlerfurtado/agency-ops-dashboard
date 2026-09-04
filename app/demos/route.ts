/**
 * Vitrine das demonstrações.
 *
 * O demo do Briefing Hub já morava num endereço próprio. O do CRM estava na
 * tela de login do Imobi-Board — três contas fictícias visíveis para qualquer
 * pessoa que abrisse o sistema, inclusive o cliente real. Saiu de lá e virou
 * link; esta página é onde se escolhe qual apresentar.
 *
 * Rota pública, como a do Briefing Hub: numa apresentação não dá para pedir
 * login antes de mostrar o produto. `noindex` para não aparecer em busca.
 */

const DEMOS = [
  {
    nome: "Briefing Hub",
    para: "O que o cliente preenche no onboarding",
    texto:
      "Percorre o briefing inteiro com respostas já preenchidas: produto, persona, " +
      "oferta e estratégia. Nada é gravado — os dados são fabricados na hora, então " +
      "dá para clicar em tudo sem medo.",
    href: "/briefing-hub-demo",
    marca: "BH",
  },
  {
    nome: "Imobi-Board",
    para: "O CRM que a imobiliária usa no dia a dia",
    texto:
      "Entra em duas imobiliárias fictícias com leads gerados. Na abertura você " +
      "escolhe o perfil: administrador vê a operação inteira, corretor vê só os " +
      "próprios leads — e uma imobiliária não enxerga a outra.",
    href: "https://imobi-board-app.lakassessoriadigital.workers.dev/#/demo",
    marca: "IB",
  },
];

function pagina() {
  const cartoes = DEMOS.map((d) => `
    <a class="cartao" href="${d.href}"${d.href.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>
      <span class="marca">${d.marca}</span>
      <span class="corpo">
        <strong>${d.nome}</strong>
        <small>${d.para}</small>
        <p>${d.texto}</p>
        <span class="abrir">Abrir demonstração &rarr;</span>
      </span>
    </a>`).join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Demonstrações · LAK</title>
<style>
  :root{color-scheme:dark;--bg:#0b0f16;--panel:#121824;--line:#1f2937;--text:#e5e7eb;--muted:#94a3b8;--accent:#f97316}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px 20px}
  main{width:min(760px,100%)}
  .eyebrow{font-size:11px;letter-spacing:.14em;color:var(--accent);text-transform:uppercase}
  h1{font-size:26px;margin:6px 0 4px;font-weight:650}
  .sub{color:var(--muted);margin:0 0 22px;font-size:14px}
  .cartao{display:flex;gap:16px;padding:18px;margin-bottom:12px;border:1px solid var(--line);
          border-radius:16px;background:var(--panel);text-decoration:none;color:inherit;
          transition:border-color .15s ease,transform .15s ease}
  .cartao:hover{border-color:var(--accent);transform:translateY(-1px)}
  .marca{flex:none;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;
         background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:700;font-size:14px}
  .corpo{display:block}
  .corpo strong{font-size:16px;display:block}
  .corpo small{color:var(--muted);font-size:12px;display:block;margin-top:2px}
  .corpo p{margin:9px 0 0;color:var(--muted);font-size:13px}
  .abrir{display:inline-block;margin-top:11px;font-size:13px;color:var(--accent)}
  footer{margin-top:20px;color:var(--muted);font-size:12px;line-height:1.6}
  @media(prefers-reduced-motion:reduce){.cartao{transition:none}}
</style>
</head>
<body>
<main>
  <div class="eyebrow">LAK Assessoria Digital</div>
  <h1>Demonstrações</h1>
  <p class="sub">Escolha o que apresentar. Os dois ambientes são fictícios.</p>
  ${cartoes}
  <footer>
    Nenhum dos dois toca dado de cliente. O Briefing Hub fabrica as respostas no
    navegador; o Imobi-Board usa imobiliárias de demonstração isoladas das reais.
  </footer>
</main>
</body>
</html>`;
}

export async function GET(): Promise<Response> {
  return new Response(pagina(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
