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
 *
 * Paleta do manual da Leonardo Imobi: laranja #FD6801, marinho #071C3D e azul
 * #03549B. O fundo continua escuro, os cartões passam a ser marinho e o
 * laranja fica reservado a link e acento — que é o papel dele no manual, não
 * de superfície.
 */

const MARCA_LEONARDO = "/brand/leonardo-imobi.svg";

const DEMOS = [
  {
    nome: "Briefing Hub",
    para: "O que o cliente preenche no onboarding",
    texto:
      "Percorre o briefing inteiro com respostas já preenchidas: produto, persona, " +
      "oferta e estratégia. Nada é gravado — os dados são fabricados na hora, então " +
      "dá para clicar em tudo sem medo.",
    href: "/briefing-hub-demo",
    icone: "/briefing-hub-mark.svg",
  },
  {
    nome: "Imobi-Board",
    para: "O CRM que a imobiliária usa no dia a dia",
    texto:
      "Entra em duas imobiliárias fictícias com leads gerados. Na abertura você " +
      "escolhe o perfil: administrador vê a operação inteira, corretor vê só os " +
      "próprios leads — e uma imobiliária não enxerga a outra.",
    href: "https://imobi-board-app.lakassessoriadigital.workers.dev/#/demo",
    icone: "/imobi-board-mark.svg",
  },
];

function pagina() {
  const cartoes = DEMOS.map((d) => `
    <a class="cartao" href="${d.href}"${d.href.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>
      <span class="marca"><img src="${d.icone}" alt="" width="30" height="30"></span>
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
<link rel="icon" href="${MARCA_LEONARDO}" type="image/svg+xml">
<title>Demonstrações · Leonardo Imobi</title>
<style>
  :root{
    color-scheme:dark;
    --laranja:#FD6801;
    --marinho:#071C3D;
    --azul:#03549B;
    --bg:#040A14;
    --line:#0E2C55;
    --text:#E8EEF7;
    --muted:#8FA5C2;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px 20px}
  main{width:min(760px,100%)}

  .topo{display:flex;align-items:center;gap:11px;margin-bottom:14px}
  .topo img{display:block;height:30px;width:auto}
  /* Fallback do logotipo: enquanto o arquivo nao existir, o nome ocupa o lugar
     dele em vez de deixar um icone quebrado no topo da apresentacao. */
  .topo .nome{font-size:11px;letter-spacing:.16em;color:var(--laranja);
              text-transform:uppercase;font-weight:700}

  h1{font-size:26px;margin:6px 0 4px;font-weight:650;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:0 0 22px;font-size:14px}

  .cartao{display:flex;gap:16px;padding:18px;margin-bottom:12px;
          border:1px solid var(--line);border-radius:16px;background:var(--marinho);
          text-decoration:none;color:inherit;
          transition:border-color .15s ease,transform .15s ease,box-shadow .15s ease}
  .cartao:hover{border-color:var(--laranja);transform:translateY(-1px);
                box-shadow:0 10px 30px rgba(3,84,155,.28)}

  /* fundo neutro atras do icone: o marinho do cartao ja e a superficie, e um
     segundo bloco colorido faria dois logotipos brigando */
  .marca{flex:none;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;
         background:rgba(3,84,155,.16);border:1px solid var(--line)}
  .marca img{display:block}

  .corpo{display:block}
  .corpo strong{font-size:16px;display:block}
  .corpo small{color:var(--muted);font-size:12px;display:block;margin-top:2px}
  .corpo p{margin:9px 0 0;color:var(--muted);font-size:13px}
  .abrir{display:inline-block;margin-top:11px;font-size:13px;color:var(--laranja);font-weight:600}

  footer{margin-top:20px;color:var(--muted);font-size:12px;line-height:1.6}
  @media(prefers-reduced-motion:reduce){.cartao{transition:none}}
</style>
</head>
<body>
<main>
  <div class="topo">
    <img src="${MARCA_LEONARDO}" alt="Leonardo Imobi"
         onerror="this.remove();document.getElementById('nome-marca').hidden=false">
    <span class="nome" id="nome-marca" hidden>Leonardo Imobi</span>
  </div>
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
