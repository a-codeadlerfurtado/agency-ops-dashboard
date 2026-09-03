import { useEffect, useState } from "react";
import { useSessao } from "./lib/session";
import { primeiroNome } from "./lib/format";
import { Alerta, Avatar, Card, Ico, MarcaImobiBoard, Skeleton } from "./ui";
import type { Sessao } from "./lib/types";

import Login from "./pages/Login";
import VisaoGeral from "./pages/VisaoGeral";
import Leads from "./pages/Leads";
import LeadDetalhe from "./pages/LeadDetalhe";
import Pipeline from "./pages/Pipeline";
import FollowUps from "./pages/FollowUps";
import Corretores from "./pages/Corretores";
import Ranking from "./pages/Ranking";
import Imoveis from "./pages/Imoveis";
import Visitas from "./pages/Visitas";
import Propostas from "./pages/Propostas";
import Vendas from "./pages/Vendas";
import Distribuicao from "./pages/Distribuicao";

/* Router por hash: sem dependencia, sem servidor de rotas, funciona em
   qualquer host estatico. Para 8 telas, react-router seria peso morto. */
function useRota() {
  const [rota, setRota] = useState(() => location.hash.slice(1) || "/");
  useEffect(() => {
    const ao = () => setRota(location.hash.slice(1) || "/");
    addEventListener("hashchange", ao);
    return () => removeEventListener("hashchange", ao);
  }, []);
  return rota;
}

export const irPara = (r: string) => { location.hash = r; };

interface ItemNav {
  rota: string; rotulo: string; icone: () => React.ReactNode; soAdmin?: boolean;
}

const NAV_TOPO: ItemNav[] = [
  { rota: "/",          rotulo: "Visao Geral", icone: () => Ico.home() },
];

const NAV_COMERCIAL: ItemNav[] = [
  { rota: "/leads",     rotulo: "Leads",       icone: () => Ico.users() },
  { rota: "/pipeline",  rotulo: "Pipeline",    icone: () => Ico.board() },
  { rota: "/followups", rotulo: "Follow-ups",  icone: () => Ico.clock() },
];

const NAV_PORTFOLIO: ItemNav[] = [
  { rota: "/imoveis",   rotulo: "Imoveis",   icone: () => Ico.building() },
  { rota: "/visitas",   rotulo: "Visitas",   icone: () => Ico.clock() },
  { rota: "/propostas", rotulo: "Propostas", icone: () => Ico.note() },
  { rota: "/vendas",    rotulo: "Vendas",    icone: () => Ico.trophy() },
];

const NAV_GESTAO: ItemNav[] = [
  { rota: "/corretores",   rotulo: "Corretores",   icone: () => Ico.users(),  soAdmin: true },
  { rota: "/distribuicao", rotulo: "Distribuicao", icone: () => Ico.arrow(),  soAdmin: true },
  { rota: "/ranking",      rotulo: "Ranking",      icone: () => Ico.trophy(), soAdmin: true },
];

function Nav({ sessao, rota, aoNavegar }: {
  sessao: Sessao; rota: string; aoNavegar: () => void;
}) {
  const item = (i: ItemNav) => (
    <button
      key={i.rota}
      className="nav-item"
      aria-current={rota === i.rota || (i.rota !== "/" && rota.startsWith(i.rota)) ? "page" : undefined}
      onClick={() => { irPara(i.rota); aoNavegar(); }}
    >
      {i.icone()}
      {i.rotulo}
    </button>
  );

  const gestao = NAV_GESTAO.filter((i) => !i.soAdmin || sessao.isAdmin);

  return (
    <nav className="nav">
      {NAV_TOPO.map(item)}
      <div className="nav-group">Comercial</div>
      {NAV_COMERCIAL.map((i) =>
        item(i.rota === "/leads" && !sessao.isAdmin ? { ...i, rotulo: "Meus Leads" } : i)
      )}
      <div className="nav-group">Portfolio</div>
      {NAV_PORTFOLIO.map((i) =>
        item(i.rota === "/vendas" && !sessao.isAdmin ? { ...i, rotulo: "Minhas Vendas" } : i)
      )}
      {gestao.length > 0 && (
        <>
          <div className="nav-group">Gestao</div>
          {gestao.map(item)}
        </>
      )}
    </nav>
  );
}

function Shell({ sessao, sair }: { sessao: Sessao; sair: () => Promise<void> }) {
  const rota = useRota();
  const [menuAberto, setMenuAberto] = useState(false);

  useEffect(() => { setMenuAberto(false); }, [rota]);

  const partes = rota.split("/").filter(Boolean);
  const leadId = partes[0] === "leads" && partes[1] ? partes[1] : null;

  let titulo = "Visao Geral";
  let pagina: React.ReactNode;

  if (leadId) {
    titulo = "Lead";
    pagina = <LeadDetalhe sessao={sessao} oppId={leadId} />;
  } else {
    switch ("/" + (partes[0] ?? "")) {
      case "/leads":
        titulo = sessao.isAdmin ? "Leads" : "Meus Leads";
        pagina = <Leads sessao={sessao} />;
        break;
      case "/pipeline":
        titulo = "Pipeline";
        pagina = <Pipeline sessao={sessao} />;
        break;
      case "/followups":
        titulo = "Follow-ups";
        pagina = <FollowUps sessao={sessao} />;
        break;
      case "/imoveis":
        titulo = "Imoveis";
        pagina = <Imoveis sessao={sessao} />;
        break;
      case "/visitas":
        titulo = "Visitas";
        pagina = <Visitas sessao={sessao} />;
        break;
      case "/propostas":
        titulo = "Propostas";
        pagina = <Propostas sessao={sessao} />;
        break;
      case "/vendas":
        titulo = sessao.isAdmin ? "Vendas" : "Minhas Vendas";
        pagina = <Vendas sessao={sessao} />;
        break;
      case "/distribuicao":
        titulo = "Distribuicao";
        pagina = sessao.isAdmin ? <Distribuicao sessao={sessao} /> : <SemPermissao />;
        break;
      case "/corretores":
        titulo = "Corretores";
        pagina = sessao.isAdmin
          ? <Corretores sessao={sessao} />
          : <SemPermissao />;
        break;
      case "/ranking":
        titulo = "Ranking";
        pagina = sessao.isAdmin
          ? <Ranking sessao={sessao} />
          : <SemPermissao />;
        break;
      default:
        pagina = <VisaoGeral sessao={sessao} />;
    }
  }

  return (
    <div className="app">
      {menuAberto && <div className="scrim" onClick={() => setMenuAberto(false)} />}

      <aside className={`sidebar ${menuAberto ? "open" : ""}`.trim()}>
        <div className="brand">
          <div className="brand-mark"><MarcaImobiBoard /></div>
          <div className="brand-name">Imobi-Board</div>
        </div>

        <Nav sessao={sessao} rota={rota} aoNavegar={() => setMenuAberto(false)} />

        <div className="sidebar-foot">
          <div className="row" style={{ padding: "6px 4px" }}>
            <Avatar nome={sessao.nome} />
            <div className="col" style={{ minWidth: 0, gap: 0 }}>
              <div className="truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                {sessao.nome}
              </div>
              <div className="truncate" style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>
                {sessao.tenant.name} · {sessao.isAdmin ? "Admin" : "Corretor"}
              </div>
            </div>
            <button className="btn ghost sm" onClick={sair} title="Sair" aria-label="Sair">
              {Ico.out({ size: 15 })}
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            className="btn ghost sm mobile-only"
            onClick={() => setMenuAberto(true)}
            aria-label="Abrir menu"
          >
            {Ico.menu()}
          </button>
          <div className="topbar-title">{titulo}</div>
          <div className="topbar-sub">{sessao.tenant.name}</div>
        </header>
        <main className="content">{pagina}</main>
      </div>
    </div>
  );
}

const SemPermissao = () => (
  <Card>
    <div className="empty">
      <div className="empty-icon">{Ico.alert({ size: 20 })}</div>
      <h3>Area restrita</h3>
      <p>Esta secao e exclusiva da administracao da imobiliaria.</p>
    </div>
  </Card>
);

function Carregando() {
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <Skeleton h={28} w={220} />
      <div style={{ height: 18 }} />
      <div className="grid cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} h={96} />)}
      </div>
    </div>
  );
}

export default function App() {
  const { estado, entrar, sair } = useSessao();

  if (estado.fase === "carregando") return <Carregando />;
  if (estado.fase === "deslogado") return <Login entrar={entrar} />;

  if (estado.fase === "erro") {
    return (
      <div className="login-shell">
        <div className="login-card">
          <Alerta>{estado.mensagem}</Alerta>
          <div style={{ height: 12 }} />
          <button className="btn wide" onClick={sair}>Sair e tentar de novo</button>
        </div>
      </div>
    );
  }

  if (estado.fase === "sem-tenant") {
    return (
      <div className="login-shell">
        <div className="login-card">
          <Card>
            <div className="empty">
              <div className="empty-icon">{Ico.building({ size: 20 })}</div>
              <h3>Conta sem imobiliaria</h3>
              <p>
                {estado.email} entrou, mas ainda nao esta vinculado a nenhuma
                imobiliaria. Peca ao administrador para incluir voce.
              </p>
              <button className="btn" onClick={sair}>Sair</button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return <Shell sessao={estado.sessao} sair={sair} />;
}

export { primeiroNome };
