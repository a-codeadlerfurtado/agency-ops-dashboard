/**
 * Vitrine dos tutoriais internos.
 *
 * Irmã da rota `/demos`, com uma diferença de propósito que vale registrar:
 * `/demos` existe para mostrar o produto a quem está de fora, com dados
 * fictícios. Esta aqui é para dentro — treinamento do time em como operar o
 * que a gente construiu. Por isso o conteúdo é apresentação com tela real do
 * sistema, e não ambiente de mentira.
 *
 * O deck em si é arquivo estático em `public/tutoriais/<nome>.html`. Esta rota
 * é só o índice. Essa separação é de propósito: o Workers Assets resolve o
 * estático antes do route handler, então um deck novo entra só soltando o
 * arquivo em `public/` e acrescentando uma linha em TUTORIAIS. Não há código a
 * escrever por tutorial.
 *
 * Caminho sem colisão: o índice responde em `/tutoriais`, cada deck em
 * `/tutoriais/<nome>.html` e as imagens em `/tutoriais/<nome>/`. Como não
 * existe `public/tutoriais/index.html`, o estático não sequestra `/tutoriais`
 * — que foi exatamente o problema documentado no topo de
 * `app/briefing-hub-demo/route.ts`.
 *
 * Rota autenticada? Não. Igual à `/demos`: numa reunião de treinamento não dá
 * para pedir login no telão, e o conteúdo é como a ferramenta funciona, não
 * dado de cliente. As telas que aparecem nos decks são de campanha de teste.
 * `noindex` para não cair em busca.
 *
 * Paleta do manual: laranja #FD6801, marinho #071C3D, azul #03549B.
 */

/**
 * O logotipo oficial é o `BrandMark` de `app/shared.tsx` — mesmo viewBox, mesmos
 * quatro traços. Aqui ele vai inline, e não como `/brand/leonardo-imobi.svg`:
 * esse arquivo não existe no `public/`, e a `/demos` convive com um fallback de
 * texto justamente por isso. Inline não tem como quebrar, herda a cor do tema e
 * ainda serve de favicon via data URI.
 */
const MARCA_SVG =
  '<svg viewBox="0 0 276 390" role="img" aria-label="Leonardo Imobi" fill="none">' +
  '<rect x="6.5" y="6.5" width="263" height="252" stroke="currentColor" stroke-width="13"/>' +
  '<rect x="0" y="252" width="13" height="138" fill="currentColor"/>' +
  '<polygon points="68,223 276,247 276,253 68,253" fill="currentColor"/>' +
  '<polygon points="0,377 208,343 208,390 0,390" fill="currentColor"/>' +
  "</svg>";

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 276 390" fill="none">' +
      '<rect x="6.5" y="6.5" width="263" height="252" stroke="#FD6801" stroke-width="13"/>' +
      '<rect x="0" y="252" width="13" height="138" fill="#FD6801"/>' +
      '<polygon points="68,223 276,247 276,253 68,253" fill="#FD6801"/>' +
      '<polygon points="0,377 208,343 208,390 0,390" fill="#FD6801"/>' +
      "</svg>",
  );

/**
 * `href` externo ao `public/tutoriais/` é de propósito: o Briefing Hub já tem
 * uma apresentação própria, servida pela rota `/briefing-hub-demo`, que é o
 * portal real do cliente com dados fictícios injetados pela Edge Function
 * `briefing-hub-presentation`. Refazer aquilo como deck aqui criaria uma
 * segunda cópia para divergir da primeira — que é exatamente o problema
 * documentado no topo de `app/briefing-hub-demo/route.ts`. Então o cartão
 * aponta para lá.
 *
 * Por isso `formato`: os decks se navegam por slide, o Briefing Hub se navega
 * clicando. Dizer isso no cartão evita que alguém abra esperando setas.
 */
type Tutorial = {
  nome: string;
  para: string;
  texto: string;
  href: string;
  duracao: string;
  publico: string;
  formato: "deck" | "ambiente";
};

type Grupo = { titulo: string; nota: string; itens: Tutorial[] };

const GRUPOS: Grupo[] = [
  {
    titulo: "Gestão de tráfego",
    nota: "Quem monta e cuida de campanha.",
    itens: [
      {
        nome: "Campaign Builder",
        para: "Criar campanha, formulário e entrega do lead em um clique",
        texto:
          "Por que a ferramenta existe, o caminho completo tela por tela, o checklist de " +
          "revisão obrigatória antes de ativar, e o que o CS precisa saber sobre a roleta " +
          "de corretores e a entrega no WhatsApp.",
        href: "/tutoriais/campaign-builder.html",
        duracao: "18 telas",
        publico: "GT e CS",
        formato: "deck",
      },
      {
        nome: "CPL Guard",
        para: "O freio automático quando o custo por lead dispara",
        texto:
          "O que a regra faz e o que ela não faz, de onde sai o CPL ideal de cada cliente, " +
          "por que o limite é 2x no anúncio e 3x no conjunto, como ler o aviso que chega no " +
          "WhatsApp e o que fazer nos primeiros minutos depois dele.",
        href: "/tutoriais/cpl-guard.html",
        duracao: "11 telas",
        publico: "GT e Adler",
        formato: "deck",
      },
    ],
  },
  {
    titulo: "Customer Success",
    nota: "Quem fala com o cliente e responde pela entrega.",
    itens: [
      {
        nome: "Conferência de Leads e relatórios",
        para: "A conferência diária, o relatório semanal e o mensal",
        texto:
          "Como ler a conferência do dia, o que cada divergência quer de você, por que um " +
          "lead sem campanha conciliada não é o mesmo que lead perdido, e o passo a passo " +
          "de fechar o relatório semanal e o mensal sem retrabalho.",
        href: "/tutoriais/conferencia-leads.html",
        duracao: "12 telas",
        publico: "CS e GT",
        formato: "deck",
      },
      {
        nome: "Briefing Hub",
        para: "O portal que o cliente usa para preencher produto e persona",
        texto:
          "A mesma apresentação que já roda no Briefing Hub: o portal de verdade, com " +
          "dados de exemplo, para você clicar à vontade. Serve para treinar o atendimento " +
          "e para mostrar ao cliente como preencher antes de liberar o acesso dele.",
        href: "/briefing-hub-demo",
        duracao: "ambiente navegável",
        publico: "CS e comercial",
        formato: "ambiente",
      },
    ],
  },
];

const TOTAL = GRUPOS.reduce((n, g) => n + g.itens.length, 0);

function escapar(valor: string) {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cartao(item: Tutorial) {
  const externo = !item.href.startsWith("/tutoriais/");
  const selo = item.formato === "ambiente" ? "Ambiente" : "Apresentação";
  const abrir =
    item.formato === "ambiente" ? "Abrir ambiente →" : "Abrir apresentação →";
  return `
  <a class="cartao${externo ? " externo" : ""}" href="${escapar(item.href)}" target="_blank" rel="noopener">
    <span class="marca" aria-hidden="true">${MARCA_SVG}</span>
    <span class="corpo">
      <strong>${escapar(item.nome)}</strong>
      <small>${escapar(item.para)}</small>
      <p>${escapar(item.texto)}</p>
      <span class="meta">
        <span class="selo">${escapar(selo)}</span>
        ${escapar(item.publico)} · ${escapar(item.duracao)}
      </span>
      <span class="abrir">${escapar(abrir)}</span>
    </span>
  </a>`;
}

function secao(g: Grupo) {
  return `
  <section class="grupo">
    <h2>${escapar(g.titulo)} <span class="qtd">${g.itens.length}</span></h2>
    <p class="nota">${escapar(g.nota)}</p>
    ${g.itens.map(cartao).join("")}
  </section>`;
}

function pagina() {
  const secoes = GRUPOS.map(secao).join("");
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Tutoriais · Leonardo Imobi</title>
<link rel="icon" href="${FAVICON}" type="image/svg+xml">
<style>
  :root{
    --marinho:#071C3D; --fundo:#040F22; --azul:#03549B; --laranja:#FD6801;
    --texto:#F6F7F9; --muted:#8A9BB5; --line:rgba(138,155,181,.22);
    color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--fundo);color:var(--texto);
       font:15px/1.6 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
       -webkit-font-smoothing:antialiased}
  main{max-width:720px;margin:0 auto;
       padding-block:clamp(36px,7vh,68px);
       padding-left:max(16px,env(safe-area-inset-left,0px));
       padding-right:max(16px,env(safe-area-inset-right,0px))}

  .topo{display:flex;align-items:center;gap:11px;margin-bottom:26px;color:var(--laranja)}
  .topo-marca{display:block;width:20px}
  .topo-marca svg{display:block;width:100%;height:auto}
  .topo .nome{font-size:11px;letter-spacing:.16em;color:var(--laranja);
              text-transform:uppercase;font-weight:700}

  h1{font-size:26px;margin:6px 0 4px;font-weight:650;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:0 0 22px;font-size:14px}

  .grupo{margin:0 0 30px}
  .grupo h2{font-size:12px;letter-spacing:.15em;text-transform:uppercase;
            color:var(--texto);font-weight:700;margin:0 0 3px;
            display:flex;align-items:center;gap:8px}
  .grupo .qtd{font-size:10px;letter-spacing:0;color:var(--laranja);
              border:1px solid var(--line);border-radius:999px;
              padding:1px 7px;font-weight:700}
  .grupo .nota{margin:0 0 13px;color:var(--muted);font-size:12.5px}

  .cartao{display:flex;gap:16px;padding:18px;margin-bottom:12px;
          border:1px solid var(--line);border-radius:16px;background:var(--marinho);
          text-decoration:none;color:inherit;
          transition:border-color .15s ease,transform .15s ease,box-shadow .15s ease}
  .cartao:hover{border-color:var(--laranja);transform:translateY(-1px);
                box-shadow:0 10px 30px rgba(3,84,155,.28)}
  .cartao:focus-visible{outline:2px solid var(--laranja);outline-offset:3px}

  .marca{flex:none;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;
         background:rgba(3,84,155,.16);border:1px solid var(--line);color:var(--laranja)}
  .marca svg{display:block;width:17px;height:auto}

  .corpo{display:block;min-width:0}
  .corpo strong{font-size:16px;display:block}
  .corpo small{color:var(--muted);font-size:12px;display:block;margin-top:2px}
  .corpo p{margin:9px 0 0;color:var(--muted);font-size:13px}
  .meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
        margin-top:10px;font-size:11px;letter-spacing:.14em;
        text-transform:uppercase;color:var(--azul);font-weight:600}
  .selo{letter-spacing:.1em;color:var(--texto);background:rgba(253,104,1,.14);
        border:1px solid rgba(253,104,1,.4);border-radius:999px;padding:2px 8px;
        font-size:10px}
  /* O Briefing Hub sai da pasta dos decks: a borda tracejada avisa que o
     destino é outra parte do sistema, não um deck deste conjunto. */
  .cartao.externo{border-style:dashed}
  .cartao.externo .selo{background:rgba(3,84,155,.18);
                        border-color:rgba(3,84,155,.5)}
  .abrir{display:inline-block;margin-top:9px;font-size:13px;color:var(--laranja);font-weight:600}

  footer{margin-top:20px;color:var(--muted);font-size:12px;line-height:1.6}
  @media(prefers-reduced-motion:reduce){.cartao{transition:none}}
</style>
</head>
<body>
<main>
  <div class="topo">
    <span class="topo-marca">${MARCA_SVG}</span>
    <span class="nome">Leonardo Imobi</span>
  </div>
  <h1>Tutoriais</h1>
  <p class="sub">Treinamento interno das ferramentas da operação. ${TOTAL} materiais, agrupados por quem usa. As apresentações abrem em tela cheia e navegam pelas setas; o ambiente do Briefing Hub se navega clicando.</p>
  ${secoes}
  <footer>
    As telas que aparecem nas apresentações são de campanhas de teste, criadas e
    pausadas para esse fim. Nenhuma delas é campanha de cliente em veiculação. O
    ambiente do Briefing Hub é o portal real rodando com dados fictícios: nada do
    que você digitar ali chega a um cliente.
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
