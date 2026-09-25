import { ImobiBoardMark } from "../Marca";

/**
 * Páginas públicas: privacidade e termos.
 *
 * Ficam fora do app autenticado de propósito. A Meta valida a URL da política
 * de privacidade ao aprovar o aplicativo, e um validador que cai numa tela de
 * login reprova. Por isso o roteador as atende antes de olhar sessão, e por
 * isso elas respondem tanto em `/privacidade` quanto em `#/privacidade` — a
 * primeira forma é a que se cola no painel da Meta.
 *
 * O texto é específico ao que o sistema realmente faz. Onde não havia como
 * saber (CNPJ, endereço), está marcado em vez de inventado.
 */

/* Trocar aqui muda nas duas páginas. */
const CONTATO = "leonardoimobiia@gmail.com";
const EMPRESA = "Leonardo Imobi / LAK Assessoria Digital";
const ATUALIZADO = "25 de setembro de 2026";

function Casca({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="legal-shell">
      <header className="legal-topo">
        <a href="/" className="legal-marca">
          <ImobiBoardMark size={26} />
          <span>Imobi-Board</span>
        </a>
        <nav className="legal-nav">
          <a href="/privacidade">Privacidade</a>
          <a href="/termos">Termos</a>
        </nav>
      </header>

      <main className="legal">
        <h1>{titulo}</h1>
        <p className="legal-data">Atualizado em {ATUALIZADO}</p>
        {children}
      </main>

      <footer className="legal-rodape">
        {EMPRESA} · <a href={`mailto:${CONTATO}`}>{CONTATO}</a>
      </footer>
    </div>
  );
}

export function Privacidade() {
  return (
    <Casca titulo="Política de Privacidade">
      <p className="legal-resumo">
        Em resumo: recebemos os dados que a pessoa preencheu num anúncio da
        imobiliária, entregamos esses dados à imobiliária que anunciou para que
        um corretor entre em contato, e não usamos essas informações para mais
        nada. Não vendemos dados e não fazemos publicidade com eles.
      </p>

      <h2>1. Quem trata os dados</h2>
      <p>
        O Imobi-Board é operado por {EMPRESA}, que fornece a plataforma às
        imobiliárias clientes.
      </p>
      <p>
        A divisão de responsabilidade é a seguinte: a <b>imobiliária que
        veiculou o anúncio</b> é a controladora dos dados do lead, porque é ela
        quem decide anunciar, quem contata a pessoa e quem conduz a negociação.
        A {EMPRESA} atua como <b>operadora</b>, tratando os dados por conta e
        ordem dessa imobiliária, e como controladora apenas do que é necessário
        para manter a plataforma no ar (registros de acesso e auditoria).
      </p>

      <h2>2. Quais dados recebemos</h2>
      <p>Quando uma pessoa envia um formulário de anúncio no Facebook ou Instagram, recebemos:</p>
      <ul>
        <li><b>Nome</b>, <b>telefone</b> e <b>e-mail</b>, quando preenchidos no formulário;</li>
        <li>as <b>demais respostas do formulário</b> criado pela imobiliária;</li>
        <li>identificadores da <b>campanha, conjunto de anúncios e anúncio</b> de origem, e o
          identificador do lead na Meta, usados para saber de onde o contato veio;</li>
        <li>a <b>data e a hora</b> do envio;</li>
        <li>para usuários do aplicativo móvel, <b>plataforma, identificador de push
          do aparelho e vínculo com a conta/tenant</b>, usados somente para entregar
          notificações autorizadas. O ImobiBoard não recebe o dado biométrico do aparelho.</li>
      </ul>
      <p>
        Recebemos também dados enviados diretamente pela imobiliária ou pelo
        site dela, quando ela integra um formulário próprio.
      </p>
      <p>
        Não recebemos e não pedimos dados sensíveis: origem racial ou étnica,
        convicção religiosa, opinião política, dado de saúde, biometria ou vida
        sexual. Se um formulário da imobiliária coletar esse tipo de
        informação, a responsabilidade por isso é dela.
      </p>

      <h2>3. Para que usamos</h2>
      <ul>
        <li>encaminhar o contato à imobiliária que veiculou o anúncio;</li>
        <li>distribuir o atendimento a um corretor dessa imobiliária e controlar
          o prazo de resposta;</li>
        <li>registrar o histórico do atendimento para a própria imobiliária;</li>
        <li>manter registros de segurança e auditoria da plataforma.</li>
      </ul>
      <p>
        Não usamos os dados para publicidade própria, não os cedemos a
        terceiros para fins comerciais e não os vendemos.
      </p>

      <h2>4. Base legal</h2>
      <p>Tratamos os dados com fundamento na Lei nº 13.709/2018 (LGPD):</p>
      <ul>
        <li><b>Art. 7º, I — consentimento.</b> A pessoa preencheu voluntariamente um
          formulário pedindo ser contatada.</li>
        <li><b>Art. 7º, V — procedimentos preliminares a contrato</b>, a pedido do
          titular: o contato existe para viabilizar uma negociação imobiliária.</li>
        <li><b>Art. 7º, IX — legítimo interesse</b>, restrito à segurança da
          plataforma, prevenção a fraude e registros de auditoria.</li>
      </ul>

      <h2>5. Com quem compartilhamos</h2>
      <ul>
        <li><b>A imobiliária cliente</b> que veiculou o anúncio, e os corretores dela.
          Cada imobiliária vê apenas os próprios dados: a separação é aplicada no
          banco de dados, não apenas na tela.</li>
        <li><b>Provedores de infraestrutura</b>, que apenas hospedam e processam os
          dados a nosso comando:
          <ul>
            <li><b>Supabase</b> — banco de dados e autenticação, em servidores nos
              Estados Unidos (região us-east-2);</li>
            <li><b>Cloudflare</b> — hospedagem da aplicação e do serviço que recebe os
              leads, em rede distribuída globalmente.</li>
          </ul>
        </li>
        <li><b>Meta</b> (Facebook e Instagram) figura como origem dos dados, não como
          destinatária.</li>
      </ul>
      <p>
        Podemos ainda compartilhar dados quando houver <b>obrigação legal ou ordem
        de autoridade competente</b>.
      </p>

      <h2>6. Transferência internacional</h2>
      <p>
        Como os provedores acima operam fora do Brasil, há transferência
        internacional de dados, nos termos do art. 33 da LGPD. A transferência
        ocorre para viabilizar a execução do serviço solicitado e está sujeita
        às cláusulas contratuais de proteção de dados desses fornecedores.
      </p>

      <h2>7. Por quanto tempo guardamos</h2>
      <p>
        Os dados do lead permanecem enquanto durar o contrato entre a
        {" "}{EMPRESA} e a imobiliária cliente, porque é ela quem precisa do
        histórico do atendimento.
      </p>
      <p>
        Encerrado o contrato, os dados daquela imobiliária são excluídos em até
        90 dias, salvo quando a lei exigir guarda maior. Pedidos individuais de
        exclusão são atendidos em até 15 dias, independentemente disso.
      </p>
      <p>
        Registros de auditoria e de segurança podem ser mantidos por prazo
        superior, sem identificação comercial, para atender ao art. 16, I da
        LGPD.
      </p>

      <h2>8. Segurança</h2>
      <ul>
        <li>o acesso exige autenticação, e cada imobiliária só alcança os próprios
          registros — a regra é aplicada no banco de dados;</li>
        <li>credenciais e segredos de integração ficam em componentes server-side com
          acesso restrito e não são incluídos no bundle do aplicativo;</li>
        <li>fotos de imóveis ficam em armazenamento privado, acessíveis por link
          temporário e assinado;</li>
        <li>todo o tráfego é cifrado em trânsito.</li>
      </ul>
      <p>
        Nenhum sistema é imune a incidentes. Se ocorrer um incidente de
        segurança relevante, comunicaremos a imobiliária afetada e a Autoridade
        Nacional de Proteção de Dados conforme o art. 48 da LGPD.
      </p>

      <h2>9. Direitos do titular</h2>
      <p>Você pode, a qualquer momento, solicitar (art. 18 da LGPD):</p>
      <ul>
        <li>confirmação de que tratamos seus dados e acesso a eles;</li>
        <li>correção de dados incompletos, inexatos ou desatualizados;</li>
        <li>anonimização, bloqueio ou eliminação de dados desnecessários ou tratados
          em desconformidade com a lei;</li>
        <li>portabilidade a outro fornecedor;</li>
        <li>eliminação dos dados tratados com base no consentimento;</li>
        <li>informação sobre com quem compartilhamos seus dados;</li>
        <li>revogação do consentimento.</li>
      </ul>

      <h2>10. Como pedir exclusão dos seus dados</h2>
      <p>
        Escreva para <a href={`mailto:${CONTATO}`}>{CONTATO}</a> com o assunto
        <b> “Exclusão de dados”</b>, informando o telefone ou o e-mail que você
        usou no formulário. Respondemos em até 15 dias.
      </p>
      <p>
        Se você preferir, pode pedir diretamente à imobiliária que entrou em
        contato com você — ela é a controladora dos seus dados e nós atendemos
        ao pedido dela igualmente.
      </p>
      <p>
        Pode ser necessário confirmar sua identidade antes de excluir, para não
        atender a um pedido feito por outra pessoa em seu nome.
      </p>

      <h2>11. Alterações</h2>
      <p>
        Esta política pode ser atualizada. A data no topo indica a última
        alteração. Mudanças relevantes serão comunicadas às imobiliárias
        clientes.
      </p>
    </Casca>
  );
}

export function Termos() {
  return (
    <Casca titulo="Termos de Uso">
      <p className="legal-resumo">
        O Imobi-Board é um CRM para imobiliárias. Estes termos valem para quem
        usa o sistema — imobiliárias e seus corretores.
      </p>

      <h2>1. O que é o serviço</h2>
      <p>
        O Imobi-Board recebe leads de anúncios e formulários, distribui o
        atendimento entre os corretores da imobiliária, controla prazos de
        resposta e registra visitas, propostas e vendas.
      </p>

      <h2>2. Quem pode usar</h2>
      <p>
        O acesso é criado por convite. Cada pessoa recebe um acesso individual
        e responde pelo que faz com ele. É proibido compartilhar senha: o
        registro de auditoria atribui cada ação a uma conta.
      </p>

      <h2>3. Responsabilidade sobre os dados</h2>
      <p>
        A imobiliária é responsável pelos dados que insere e pelos que recebe
        de seus anúncios, inclusive por ter base legal para tratá-los e por
        responder aos titulares. A {EMPRESA} atua como operadora, seguindo as
        instruções da imobiliária.
      </p>

      <h2>4. Uso aceitável</h2>
      <p>Ao usar o sistema, você concorda em não:</p>
      <ul>
        <li>importar contatos obtidos sem base legal, comprados ou raspados;</li>
        <li>usar os dados para finalidade diferente do atendimento imobiliário;</li>
        <li>tentar acessar dados de outra imobiliária;</li>
        <li>automatizar o uso de forma que degrade o serviço para os demais.</li>
      </ul>

      <h2>5. Disponibilidade</h2>
      <p>
        Trabalhamos para manter o serviço disponível, mas ele é fornecido no
        estado em que se encontra, sem garantia de funcionamento ininterrupto.
        Podem ocorrer paradas para manutenção ou por falha de fornecedores de
        infraestrutura.
      </p>

      <h2>6. Integrações de terceiros</h2>
      <p>
        Integrações com Meta, provedores de automação e outros serviços estão
        sujeitas às regras e à disponibilidade dessas plataformas. Mudanças
        feitas por elas podem afetar o funcionamento da integração sem aviso
        prévio.
      </p>

      <h2>7. Propriedade</h2>
      <p>
        O software, a marca e a interface pertencem à {EMPRESA}. Os dados
        comerciais inseridos pela imobiliária continuam sendo dela, e podem ser
        exportados enquanto o contrato estiver vigente.
      </p>

      <h2>8. Encerramento</h2>
      <p>
        O contrato pode ser encerrado por qualquer das partes. Encerrado o
        contrato, o acesso é desativado e os dados são excluídos conforme o
        prazo descrito na <a href="/privacidade">Política de Privacidade</a>.
      </p>

      <h2>9. Alterações</h2>
      <p>
        Estes termos podem ser atualizados; a data no topo indica a última
        alteração. O uso continuado após a mudança significa concordância.
      </p>

      <h2>10. Foro</h2>
      <p>
        Aplica-se a legislação brasileira. Dúvidas e contato:{" "}
        <a href={`mailto:${CONTATO}`}>{CONTATO}</a>.
      </p>
    </Casca>
  );
}
