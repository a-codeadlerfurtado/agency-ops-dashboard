import type { Sessao } from "./lib/types";
import { impactoLeve } from "./lib/native";
import { Ico } from "./ui";
import { irPara } from "./App";

export default function MobileNav({
  sessao, rota, aoAbrirMais,
}: {
  sessao: Sessao;
  rota: string;
  aoAbrirMais: () => void;
}) {
  const itens = [
    { rota: "/", rotulo: "Inicio", icone: () => Ico.home({ size: 19 }) },
    {
      rota: "/leads",
      rotulo: sessao.isAdmin ? "Leads" : "Meus leads",
      icone: () => Ico.users({ size: 19 }),
    },
    { rota: "/pipeline", rotulo: "Pipeline", icone: () => Ico.board({ size: 19 }) },
    { rota: "/followups", rotulo: "Follow-ups", icone: () => Ico.clock({ size: 19 }) },
  ];

  return (
    <nav className="mobile-nav" aria-label="Navegacao principal">
      {itens.map((item) => {
        const ativo = rota === item.rota || (item.rota !== "/" && rota.startsWith(item.rota));
        return (
          <button
            key={item.rota}
            className="mobile-nav-item"
            aria-current={ativo ? "page" : undefined}
            onClick={() => {
              void impactoLeve();
              irPara(item.rota);
            }}
          >
            {item.icone()}
            <span>{item.rotulo}</span>
          </button>
        );
      })}
      <button
        className="mobile-nav-item"
        onClick={() => {
          void impactoLeve();
          aoAbrirMais();
        }}
      >
        {Ico.menu({ size: 19 })}
        <span>Mais</span>
      </button>
    </nav>
  );
}
