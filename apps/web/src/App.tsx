import { useEffect, useState } from "react";
import { useSessao } from "./lib/session";
import { primeiroNome } from "./lib/format";
import { Alerta, Avatar, Card, Ico, Skeleton } from "./ui";
import { ImobiBoardLogo, ImobiBoardMark } from "./Marca";
import type { Sessao } from "./lib/types";

import Login from "./pages/Login";
import Convite from "./pages/Convite";
import NovaSenha from "./pages/NovaSenha";
import Operacao from "./pages/Operacao";
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
import Integracoes from "./pages/Integracoes";
import Topbar from "./Topbar";

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
  { rota: "/integracoes",  rotulo: "Integracoes",  icone: () => Ico.gear(),   soAdmin: true },
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

  /* Operacao nao entra em NAV_GESTAO porque nao e mais permissao dentro da
     imobiliaria: e outro nivel, e quem o tem normalmente nem pertence a uma. */
  const operacao: ItemNav[] = sessao.ehOperador
    ? [{ rota: "/operacao", rotulo: "Imobiliarias", icone: () => Ico.building() }]
    : [];

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
      {operacao.length > 0 && (
        <>
          <div className="nav-group">Operacao</div>
          {operacao.map(item)}
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
      case "/integracoes":
        titulo = "Integracoes";
        pagina = sessao.isAdmin ? <Integracoes sessao={sessao} /> : <SemPermissao />;
        break;
      case "/operacao":
        titulo = "Operacao";
        pagina = sessao.ehOperador ? <Operacao /> : <SemPermissao />;
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
          <ImobiBoardLogo size={26} />
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
        <Topbar sessao={sessao} titulo={titulo} aoAbrirMenu={() => setMenuAberto(true)} />
        <main className="content">{pagina}</main>
      </div>
    </div>
  );
}

/**
 * Casca do operador que não pertence a nenhuma imobiliária — que é o caso
 * normal de quem toca a operação. Sem isto ele cairia na tela "conta sem
 * imobiliária" e não teria por onde criar a primeira.
 *
 * Sem sidebar de propósito: aqui não existe pipeline, lead nem imóvel. Uma
 * barra e uma tela.
 */
function ConsoleDaOperacao({ email, sair }: { email: string; sair: () => Promise<void> }) {
  return (
    <div className="app" style={{ gridTemplateColumns: "1fr" }}>
      <div className="main">
        <header className="topbar">
          <span className="topbar-marca" style={{ display: "flex" }}>
            <ImobiBoardMark size={24} />
          </span>
          <div>
            <div className="eyebrow">Imobi-Board</div>
            <div className="topbar-title">Operacao</div>
          </div>
          <span className="spacer" />
          <span className="topbar-sub some-no-mobile">{email}</span>
          <button className="btn ghost sm" onClick={sair} title="Sair" aria-label="Sair">
            {Ico.out({ size: 15 })}
          </button>
        </header>
        <main className="content"><Operacao /></main>
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
  const rota = useRota();

  // Convite tem tela propria e precisa funcionar antes de existir sessao:
  // a pessoa convidada normalmente ainda nao tem conta.
  const convite = rota.startsWith("/convite/") ? rota.slice("/convite/".length) : null;
  if (convite) return <Convite token={convite} />;

  // Recuperacao de senha: o link do e-mail traz a sessao, entao vem antes da
  // checagem normal de login.
  if (rota.startsWith("/nova-senha")) return <NovaSenha />;

  if (estado.fase === "carregando") return <Carregando />;
  if (estado.fase === "deslogado") return <Login entrar={entrar} />;

  if (estado.fase === "erro") {
    return (
      <div className="login-shell" style={{ gridTemplateColumns: "1fr" }}>
        <div className="login-card" style={{ margin: "auto", padding: 24 }}>
          <Alerta>{estado.mensagem}</Alerta>
          <div style={{ height: 12 }} />
          <button className="btn wide" onClick={sair}>Sair e tentar de novo</button>
        </div>
      </div>
    );
  }

  if (estado.fase === "operador") return <ConsoleDaOperacao sair={sair} email={estado.email} />;

  if (estado.fase === "sem-tenant") {
    return (
      <div className="login-shell" style={{ gridTemplateColumns: "1fr" }}>
        <div className="login-card" style={{ margin: "auto", padding: 24 }}>
          <Card>
            <div className="empty">
              <div style={{ marginBottom: 12 }}><ImobiBoardMark size={34} /></div>
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
