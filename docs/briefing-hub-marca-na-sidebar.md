# Sidebar do Briefing Hub: o ícone do produto no lugar das iniciais do cliente

Este documento existe porque o fonte do Briefing Hub não está no repositório do
dashboard — o worker `agency-briefing-hub` é publicado de outro lugar. O que
segue é o diagnóstico feito sobre o HTML publicado e o patch pronto para
aplicar lá.

## O que acontece hoje

O HTML base já nasce correto:

```html
<div class="bh-side-brand">
  <div class="bh-side-logo">BH</div>
  <div><b>Briefing Hub</b><small>Leonardo Imobi</small></div>
</div>
```

Em tempo de execução, `applyClientIdentity()` troca esse conteúdo pelas
iniciais do cliente:

```js
function applyClientIdentity(x){
  let l = $('.bh-side-logo');
  if (!l) return;
  let initials = identityInitials(S.me);
  l.classList.remove('has-image','logo-fit');
  l.textContent = initials;                 // "IH" entra no lugar de "BH"
  if (x && x.image_url) {
    let img = document.createElement('img');
    img.src = x.image_url;
    img.alt = 'Identidade do cliente';
    img.onload = () => { l.classList.add('has-image'); /* ... */ };
  }
}
```

Ou seja: aquele quadrado nunca foi a marca do produto. Ele é o espaço da
identidade do **cliente** — iniciais por padrão, logotipo do cliente quando
houver `image_url`. Não é um bug de layout; é uma decisão de produto que agora
está sendo revertida.

## O que passa a valer

O bloco mostra o ícone do **Briefing Hub**. O nome da imobiliária continua onde
já está, no `<small>` abaixo de "Briefing Hub".

### 1. Ícone

Salvar o arquivo em `public/brand/briefing-hub-icon.svg` no repositório do Hub.
O desenho está em `public/brand/briefing-hub-icon.svg` neste repositório e pode
ser copiado como está. Há também a variante reduzida
`briefing-hub-favicon.svg`, para a aba — a marca completa vira borrão em 16px.

No `<head>`:

```html
<link rel="icon" href="/brand/briefing-hub-favicon.svg" type="image/svg+xml">
```

### 2. Markup da sidebar

```html
<div class="bh-side-brand">
  <div class="bh-side-logo has-image logo-fit">
    <img src="/brand/briefing-hub-icon.svg" alt="Briefing Hub">
  </div>
  <div class="bh-side-nome">
    <b>Briefing Hub</b>
    <small>Leonardo Imobi</small>
  </div>
</div>
```

### 3. `applyClientIdentity` para de escrever ali

A função continua existindo — ela ainda serve para outras partes que usem a
identidade do cliente —, mas deixa de tocar `.bh-side-logo`:

```js
function applyClientIdentity(x){
  // O bloco da sidebar e do produto, nao do cliente. O nome da imobiliaria
  // aparece no <small> logo abaixo; repetir a identidade dela no quadrado
  // tirava a marca do Briefing Hub da propria tela do Briefing Hub.
  // Se algum dia o logotipo do cliente precisar aparecer, que seja em outro
  // lugar -- nao por cima da marca do produto.
}
```

Se preferir manter a função para uso futuro, basta remover as três linhas que
mexem em `l` (`classList.remove`, `textContent` e o bloco do `img`).

### 4. Layout, para não sobrepor em nenhuma largura

O CSS atual já é flex e não deveria sobrepor:

```css
.bh-side-brand{display:flex;align-items:center;gap:11px;padding:4px 7px 17px}
.bh-side-logo{width:42px;height:42px;flex:0 0 42px;overflow:hidden}
```

O que quebra é a regra do modo estreito, que esconde o texto e recentraliza:

```css
.bh-side-brand > div:last-child{display:none}
```

Com o markup acima o texto passa a ter classe própria, então a regra fica
explícita em vez de depender da posição do elemento:

```css
.bh-side-nome{min-width:0}                    /* deixa o texto encolher */
.bh-side-nome b,
.bh-side-nome small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bh-shell.compacto .bh-side-nome{display:none}   /* no lugar de div:last-child */
```

`min-width:0` é o que impede a sobreposição de verdade: sem ele um item flex
não encolhe abaixo do conteúdo, e um nome longo de imobiliária empurra o texto
por cima do ícone em telas estreitas.

## Dashboard interno (aba Briefings)

Verificado: **não compartilha este componente.** `app/briefing-staff-bridge.tsx`
monta outra interface ("Briefing Hub · Operação", com abas Resumo, Produtos,
Personas, Estratégia e Materiais) e não tem bloco de iniciais nem sidebar de
marca. Nada a mudar lá.
