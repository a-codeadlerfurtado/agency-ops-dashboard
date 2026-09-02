"use client";

import { useMemo, useState } from "react";

const demo = {
  client: "Imobiliária Horizonte",
  city: "São José dos Campos · SP",
  product: {
    name: "Residencial Aurora",
    type: "Apartamento residencial",
    location: "Jardim Aquarius",
    price: "A partir de R$ 890.000,00",
    area: "92 a 118 m²",
    bedrooms: "3 dormitórios · 1 suíte",
    highlights: ["Varanda gourmet", "2 vagas", "Lazer completo", "Próximo a escolas e serviços"],
    objective: "Gerar demanda qualificada de famílias que já pesquisam imóveis de médio/alto padrão na região e investidores buscando valorização." 
  },
  persona: {
    name: "Casal em fase de upgrade",
    profile: "30–45 anos · renda familiar acima de R$ 18 mil · já possui ou aluga um imóvel menor",
    desires: ["Mais espaço para a família", "Segurança", "Boa localização", "Patrimônio com valorização"],
    objections: ["Entrada alta", "Receio com financiamento", "Comparação com usados maiores", "Dúvida sobre momento de compra"],
    triggers: ["Nascimento dos filhos", "Promoção ou aumento de renda", "Mudança de bairro", "Busca por condomínio mais completo"]
  },
  materials: [
    { name: "Logo oficial.svg", type: "Identidade visual", size: "248 KB" },
    { name: "Fachada 01.jpg", type: "Foto do empreendimento", size: "5,8 MB" },
    { name: "Apartamento decorado.mp4", type: "Vídeo bruto", size: "184 MB" },
    { name: "Tabela Setembro.pdf", type: "Material comercial", size: "1,4 MB" }
  ]
};

type Tab = "inicio" | "produto" | "persona" | "materiais";

export default function BriefingHubDemo({ onClose }: { onClose?: () => void }) {
  const [tab, setTab] = useState<Tab>("inicio");
  const [edited, setEdited] = useState(false);
  const stats = useMemo(() => [
    ["Produto", "100%"], ["Persona", "100%"], ["Materiais", String(demo.materials.length)], ["Ambiente", "DEMO"]
  ], []);

  return <div className="bh-demo-shell">
    <style>{`
      .bh-demo-shell{position:fixed;inset:0;z-index:100000;background:#070b14;color:#edf3ff;font-family:inherit;display:grid;grid-template-columns:230px 1fr;overflow:hidden}
      .bh-demo-side{background:linear-gradient(180deg,#0b1220,#08101b);border-right:1px solid rgba(148,163,184,.13);padding:24px 18px;display:flex;flex-direction:column;gap:18px}
      .bh-demo-brand{display:flex;align-items:center;gap:10px;font-weight:800}.bh-demo-dot{width:11px;height:11px;border-radius:99px;background:#60a5fa;box-shadow:0 0 0 5px rgba(96,165,250,.1)}
      .bh-demo-badge{font-size:10px;letter-spacing:.13em;color:#93c5fd;background:rgba(59,130,246,.1);border:1px solid rgba(96,165,250,.2);border-radius:999px;padding:6px 9px;width:max-content}
      .bh-demo-client{padding:14px;border:1px solid rgba(148,163,184,.12);border-radius:14px;background:rgba(255,255,255,.025)}.bh-demo-client b{display:block;font-size:13px}.bh-demo-client small{display:block;color:#7f8da3;margin-top:4px;font-size:11px}
      .bh-demo-nav{display:grid;gap:6px}.bh-demo-nav button{border:0;background:transparent;color:#8e9bb0;text-align:left;padding:10px 11px;border-radius:10px;font:inherit;font-size:13px;cursor:pointer}.bh-demo-nav button.active{background:rgba(96,165,250,.12);color:#dceaff;font-weight:700}
      .bh-demo-sidefoot{margin-top:auto;color:#6f7d91;font-size:10px;line-height:1.5}.bh-demo-main{overflow:auto;background:radial-gradient(circle at 80% -10%,rgba(59,130,246,.1),transparent 30%),#080d16}
      .bh-demo-top{position:sticky;top:0;z-index:3;background:rgba(8,13,22,.9);backdrop-filter:blur(16px);border-bottom:1px solid rgba(148,163,184,.12);padding:14px 26px;display:flex;align-items:center;justify-content:space-between}.bh-demo-top small{color:#7f8da3}.bh-demo-actions{display:flex;gap:8px}.bh-demo-btn{border:1px solid rgba(148,163,184,.18);background:#101827;color:#dbe7f7;padding:9px 12px;border-radius:10px;font:inherit;font-size:12px;cursor:pointer}.bh-demo-btn.primary{background:#2563eb;border-color:#2563eb;color:white}.bh-demo-btn.danger{color:#fca5a5}
      .bh-demo-content{max-width:1120px;margin:0 auto;padding:34px 34px 70px}.bh-demo-kicker{font-size:11px;letter-spacing:.13em;color:#60a5fa;font-weight:800}.bh-demo-title{font-size:34px;line-height:1.08;margin:7px 0 9px;letter-spacing:-.035em}.bh-demo-sub{color:#8d9bb0;max-width:760px;line-height:1.55;font-size:14px}
      .bh-demo-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:28px 0}.bh-demo-stat,.bh-demo-card{border:1px solid rgba(148,163,184,.12);background:rgba(15,23,42,.58);border-radius:16px}.bh-demo-stat{padding:17px}.bh-demo-stat span{display:block;color:#77869c;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.bh-demo-stat b{display:block;font-size:22px;margin-top:5px}
      .bh-demo-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.bh-demo-card{padding:20px}.bh-demo-card h3{font-size:16px;margin:0 0 5px}.bh-demo-card p,.bh-demo-card li{color:#9aa8ba;font-size:13px;line-height:1.55}.bh-demo-card ul{margin:12px 0 0;padding-left:18px}.bh-demo-field{padding:14px 0;border-bottom:1px solid rgba(148,163,184,.1)}.bh-demo-field:last-child{border-bottom:0}.bh-demo-field label{display:block;color:#728198;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.bh-demo-field strong{display:block;margin-top:5px;font-size:14px}.bh-demo-example{margin-top:8px;padding:9px 10px;border-left:2px solid #3b82f6;background:rgba(59,130,246,.06);color:#8fa5c4;font-size:11px;border-radius:0 8px 8px 0}.bh-demo-table{width:100%;border-collapse:collapse;margin-top:12px}.bh-demo-table th,.bh-demo-table td{text-align:left;padding:12px;border-bottom:1px solid rgba(148,163,184,.1);font-size:12px}.bh-demo-table th{color:#6f7e95;font-size:10px;text-transform:uppercase}.bh-demo-table td{color:#c8d3e2}.bh-demo-notice{margin:18px 0;padding:12px 14px;border:1px solid rgba(96,165,250,.18);background:rgba(59,130,246,.07);border-radius:12px;color:#9ab2d3;font-size:12px}
      @media(max-width:800px){.bh-demo-shell{grid-template-columns:1fr}.bh-demo-side{display:none}.bh-demo-content{padding:24px 16px}.bh-demo-stats,.bh-demo-grid{grid-template-columns:1fr 1fr}.bh-demo-title{font-size:28px}}
    `}</style>
    <aside className="bh-demo-side">
      <div className="bh-demo-brand"><span className="bh-demo-dot"/>Briefing Hub</div>
      <span className="bh-demo-badge">AMBIENTE DE DEMONSTRAÇÃO</span>
      <div className="bh-demo-client"><b>{demo.client}</b><small>Cliente fictício · não salva em produção</small></div>
      <nav className="bh-demo-nav">
        {([['inicio','Visão geral'],['produto','Produto'],['persona','Persona'],['materiais','Materiais']] as [Tab,string][]).map(([id,label])=><button key={id} onClick={()=>setTab(id)} className={tab===id?'active':''}>{label}</button>)}
      </nav>
      <div className="bh-demo-sidefoot">Use este ambiente em apresentações comerciais e reuniões de briefing. Todos os dados exibidos aqui são fictícios.</div>
    </aside>
    <main className="bh-demo-main">
      <header className="bh-demo-top"><div><b>{demo.client}</b><small> · demonstração do portal do cliente</small></div><div className="bh-demo-actions"><button className="bh-demo-btn" onClick={()=>setEdited(true)}>Simular edição</button>{edited&&<button className="bh-demo-btn danger" onClick={()=>setEdited(false)}>Restaurar demo</button>}{onClose&&<button className="bh-demo-btn primary" onClick={onClose}>Fechar</button>}</div></header>
      <div className="bh-demo-content">
        {tab==='inicio' && <><span className="bh-demo-kicker">BRIEFING HUB · DEMO</span><h1 className="bh-demo-title">Tudo que a agência precisa saber, organizado em um só lugar.</h1><p className="bh-demo-sub">Esta é uma demonstração fiel da experiência do cliente no Briefing Hub. Produto, persona e materiais ficam centralizados e podem ser revisados pela agência a qualquer momento.</p><div className="bh-demo-stats">{stats.map(([k,v])=><div className="bh-demo-stat" key={k}><span>{k}</span><b>{v}</b></div>)}</div><div className="bh-demo-grid"><section className="bh-demo-card"><h3>Produto principal</h3><p>{demo.product.name} · {demo.product.location}</p><ul>{demo.product.highlights.slice(0,3).map(x=><li key={x}>{x}</li>)}</ul></section><section className="bh-demo-card"><h3>Persona principal</h3><p>{demo.persona.name}</p><p>{demo.persona.profile}</p></section><section className="bh-demo-card"><h3>Materiais centralizados</h3><p>{demo.materials.length} arquivos demonstrativos organizados para a equipe.</p></section><section className="bh-demo-card"><h3>O que o cliente vê</h3><p>Somente o próprio briefing, materiais e informações relacionadas ao seu negócio. Nada da operação interna da agência aparece aqui.</p></section></div></>}
        {tab==='produto' && <><span className="bh-demo-kicker">PRODUTO</span><h1 className="bh-demo-title">{demo.product.name}</h1><p className="bh-demo-sub">Exemplo de briefing preenchido. Durante uma reunião, o CS consegue usar estas respostas como referência do nível de detalhe esperado.</p><div className="bh-demo-notice">💡 Em perguntas mais abstratas, o Hub pode mostrar exemplos sem preencher nada automaticamente.</div><section className="bh-demo-card"><div className="bh-demo-field"><label>Tipo de produto</label><strong>{demo.product.type}</strong></div><div className="bh-demo-field"><label>Localização</label><strong>{demo.product.location}</strong></div><div className="bh-demo-field"><label>Faixa de preço</label><strong>{demo.product.price}</strong></div><div className="bh-demo-field"><label>Metragem</label><strong>{demo.product.area}</strong></div><div className="bh-demo-field"><label>Configuração</label><strong>{demo.product.bedrooms}</strong></div><div className="bh-demo-field"><label>Objetivo da campanha</label><strong>{demo.product.objective}</strong><div className="bh-demo-example">Exemplo de ajuda: “Explique o que você espera gerar com a campanha e para quem esse produto faz mais sentido.”</div></div></section></>}
        {tab==='persona' && <><span className="bh-demo-kicker">PERSONA</span><h1 className="bh-demo-title">{demo.persona.name}</h1><p className="bh-demo-sub">Uma persona preenchida como referência para o cliente entender que tipo de informação ajuda a estratégia de mídia e criativos.</p><div className="bh-demo-grid"><section className="bh-demo-card"><h3>Perfil</h3><p>{demo.persona.profile}</p></section><section className="bh-demo-card"><h3>Desejos</h3><ul>{demo.persona.desires.map(x=><li key={x}>{x}</li>)}</ul></section><section className="bh-demo-card"><h3>Objeções</h3><ul>{demo.persona.objections.map(x=><li key={x}>{x}</li>)}</ul><div className="bh-demo-example">Exemplo de ajuda: “O que normalmente faz esse comprador adiar ou desistir da compra?”</div></section><section className="bh-demo-card"><h3>Gatilhos de compra</h3><ul>{demo.persona.triggers.map(x=><li key={x}>{x}</li>)}</ul></section></div></>}
        {tab==='materiais' && <><span className="bh-demo-kicker">MATERIAIS</span><h1 className="bh-demo-title">Arquivos do cliente</h1><p className="bh-demo-sub">No ambiente real, os uploads aparecem aqui vinculados à pasta correta do cliente no Drive. Na demonstração, os arquivos abaixo são apenas exemplos.</p><section className="bh-demo-card"><table className="bh-demo-table"><thead><tr><th>Arquivo</th><th>Tipo</th><th>Tamanho</th></tr></thead><tbody>{demo.materials.map(x=><tr key={x.name}><td><b>{x.name}</b></td><td>{x.type}</td><td>{x.size}</td></tr>)}</tbody></table></section></>}
      </div>
    </main>
  </div>;
}
