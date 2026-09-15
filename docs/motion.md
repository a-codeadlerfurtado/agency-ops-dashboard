# Motion e interação

Documento do sistema de movimento do Imobi-Board. Existe para que nenhum
componente invente a própria duração — duração aleatória por componente é o que
faz uma interface parecer remendada.

## Decisão de dependências

```
Motion    — NÃO
Anime.js  — NÃO
GSAP      — NÃO
```

Motion custaria **~30 kB gzip** (18 kB core + ~15 kB da camada React). O que ela
resolveria já está resolvido:

| Necessidade | O que Motion faria | O que usamos | Custo |
|---|---|---|---|
| Entrada de modal/drawer | `AnimatePresence` | `@starting-style` | 0 kB |
| **Saída** antes de sair do DOM | `AnimatePresence` | `transition-behavior: allow-discrete` + `overlay` | 0 kB |
| Focus trap, Esc, backdrop | lib de modal | `<dialog>` nativo | 0 kB |
| Card mudando de coluna | `layout` / `layoutId` | `lib/flip.ts` (60 linhas) | ~1 kB |
| Ticker de número | `useSpring` | `<Numero>` com rAF | ~0,4 kB |

**Custo real do polish: +1,37 kB gzip de JS e +0,95 kB de CSS.** Medido com
`git stash` antes e depois, não estimado.

**Quando reabrir a decisão:** se precisarmos de drag com física (inércia, snap
elástico), reordenação com gesto contínuo dentro da coluna, ou shared element
entre rotas. O `flip.ts` é exatamente a peça que Motion substituiria, então a
troca fica isolada num arquivo.

## Durações

A escala segue a **distância percorrida**, não a importância. Micro-feedback é
instantâneo; algo que atravessa a tela precisa de tempo para o olho acompanhar.

| Token | Valor | Onde |
|---|---|---|
| `--d-instant` | 90 ms | cor, opacidade, borda, press |
| `--d-fast` | 160 ms | hover, foco, badge, barra da sidebar |
| `--d-base` | 240 ms | modal, drawer, toast, item entrando |
| `--d-slow` | 420 ms | FLIP do Kanban, transição de número |

## Curvas

| Token | Curva | Por quê |
|---|---|---|
| `--ease` | `cubic-bezier(0.32, 0.72, 0, 1)` | padrão. Sai rápido, chega devagar: responde no clique e assenta com calma |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | coisa que aparece: começa imóvel e acelera |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | coisa que sai: ninguém quer esperar algo desaparecer |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | **um único uso**: o check do botão ao confirmar |

## Interaction system

Cada estado tem uma linguagem, e ela não muda de tela para tela.

| Estado | Sinal | Duração |
|---|---|---|
| Hover | fundo `--blue-wash`, texto sobe para `--text` | `--d-fast` |
| Focus | anel `--blue` 2px, offset 2px, só em `:focus-visible` | imediato |
| Pressed | `scale(0.985)` | `--d-instant` |
| Selected | fundo `--blue-soft` + barra `--blue` à esquerda | `--d-fast` |
| Dragging | `opacity: .4` no card de origem | `--d-fast` |
| Dropping | coluna com borda `--accent` e fundo laranja 5% | `--d-fast` |
| Loading | skeleton com a **forma** do conteúdo real | shimmer 1,4 s |
| Salvando | botão trava a largura e mostra spinner | `--d-fast` |
| Success | check com `--ease-spring`, segura 1,2 s | `--d-fast` |
| Error | toast `--danger` + mensagem em português |  |
| Disabled | `opacity: .5`, cursor `not-allowed` |  |
| Atualizado (realtime) | realce `--accent-soft` desaparecendo, 1 vez | 1,1 s |

## Regra 80 / 15 / 5

- **80%** — layout, tipografia, densidade, hierarquia. A interface parada
  precisa ser boa; animação não salva interface ruim.
- **15%** — motion funcional: hover, modal, drawer, FLIP, loading, toast.
- **5%** — o único overshoot do sistema é o check de confirmação. Sem confete.

## Reduced motion

O bloco `prefers-reduced-motion` é a **última regra do stylesheet**, de
propósito: precisa vencer tudo que veio antes. Já esqueci isso uma vez e as
animações novas passavam por cima da preferência.

Não é só acelerar — giro infinito e realce piscando são desligados de vez. O
FLIP (`flip.ts`) e o `<Numero>` checam a media query no JS e simplesmente não
animam.

## Performance

Tudo que anima usa **só `transform` e `opacity`**, que rodam no compositor sem
tocar layout nem paint. O FLIP mede `getBoundingClientRect()` uma vez por drop,
não por frame.

Descartado por custo:
- `filter: blur` em listas — caro em celular com 100+ cards
- `mousemove` por card (spotlight, grids interativos) — mata FPS com 200 imóveis
- contador em CSS puro com `counter()` — texto não selecionável e mal lido por
  leitor de tela; num CRM alguém vai querer copiar o VGV
