import json, uuid
from pathlib import Path

def uid(): return str(uuid.uuid4())
def node(name, typ, version, pos, params, credentials=None):
    x={"id":uid(),"name":name,"type":typ,"typeVersion":version,"position":pos,"parameters":params}
    if credentials: x["credentials"]=credentials
    return x

OPENAI={"openAiApi":{"id":"UaivfiENgTeGatF3","name":"FMI Prime OpenAI"}}
base="={{ $('Webhook').item.json.body.imobiaBaseUrl }}"
token="={{ 'Bearer ' + $('Webhook').item.json.body.agentToken }}"
headers={"parameters":[{"name":"Authorization","value":token},{"name":"Content-Type","value":"application/json"}]}

nodes=[]
nodes.append(node("Webhook","n8n-nodes-base.webhook",2.1,[-900,0],{"httpMethod":"POST","path":"imobia-agent","options":{}}))
nodes.append(node("Contexto ImoBia","n8n-nodes-base.httpRequest",4.3,[-660,0],{
    "url":"={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/context' }}",
    "sendHeaders":True,"headerParameters":headers,"options":{}
}))

prepare_code=r'''const ctx=$json;
const incoming=[...(ctx.messages||[])].reverse().find(m=>m.direcao==='IN');
const cfg=ctx.config||{}; const lead=ctx.conversation||{};
const questions=[...(ctx.essentialQuestions||[]),...(ctx.qualifyingQuestions||[])]
  .map(q=>`- ${q.pergunta}${q.obrigatoria?' (obrigatoria)':''}`).join('\n');
const knowledge=(ctx.knowledge||[]).map(k=>`- [${k.escopo}] ${k.chave}: ${k.valor}`).join('\n');
const history=(ctx.messages||[]).slice(-20).map(m=>`${m.direcao==='IN'?'Cliente':'Atendente'}: ${m.conteudo||'['+m.tipo+']'}`).join('\n');
const persona=cfg.persona_nome||'ImoBia'; const tone=cfg.tom_voz||'cordial, humana e objetiva';
const prompt=`Você é ${persona}, atendente da imobiliária deste tenant, operada pela plataforma ImoBia.
Fale em português do Brasil com tom ${tone}. Mensagens curtas, naturais, sem markdown. ${cfg.usar_emoji?'Emojis discretos são permitidos.':'Não use emojis.'}
Sua missão é qualificar o lead, consultar imóveis reais quando fizer sentido e entregar um briefing claro ao corretor.
Nunca invente imóvel ou informação, negocie desconto, dê parecer jurídico, prometa financiamento, trate pagamento/boletos/contratos/vistoria/manutenção, nem feche negócio.
Para assuntos administrativos, financeiros, contratos, vistoria/manutenção, pedido explícito de humano ou irritação: use a tool Handoff imediatamente.
Faça uma pergunta por vez. Quando aprender dados estruturados ou uma resposta de qualificação, use Salvar Qualificação.
Use Buscar Imóveis apenas com dados disponíveis no contexto; nunca invente resultados. Depois de apresentar imóvel e concluir qualificação, faça Handoff.
Se houver desinteresse explícito ou pedido para parar mensagens, use Cancelar Follow-up.
Se fizer Handoff, inclua na tool a última mensagem que o cliente deve receber; depois não tente continuar o atendimento.
Dados atuais do lead: ${JSON.stringify(lead)}
Perguntas configuradas:\n${questions||'(nenhuma configurada)'}
Conhecimento da operação:\n${knowledge||'(nenhum cadastrado)'}
Histórico recente:\n${history}`;
return [{json:{...ctx,userMessage:incoming?.conteudo||'',systemPrompt:prompt}}];'''
nodes.append(node("Preparar Prompt","n8n-nodes-base.code",2,[-420,0],{"jsCode":prepare_code}))
nodes.append(node("Agente ImoBia","@n8n/n8n-nodes-langchain.agent",3,[-140,0],{
    "promptType":"define","text":"={{ $json.userMessage }}","needsFallback":True,
    "options":{"systemMessage":"={{ $json.systemPrompt }}"}
}))
nodes.append(node("OpenAI Principal","@n8n/n8n-nodes-langchain.lmChatOpenAi",1.3,[-260,260],{
    "model":{"__rl":True,"value":"gpt-4.1","mode":"list","cachedResultName":"gpt-4.1"},
    "responsesApiEnabled":False,"options":{"temperature":0.35}
},OPENAI))
nodes.append(node("OpenAI Fallback","@n8n/n8n-nodes-langchain.lmChatOpenAi",1.3,[-40,260],{
    "model":{"__rl":True,"value":"gpt-4.1","mode":"list","cachedResultName":"gpt-4.1"},
    "responsesApiEnabled":False,"options":{"temperature":0.25}
},OPENAI))
search_body={"parameters":[
 {"name":"operation","value":"={{ $fromAI('operation','VENDA ou LOCACAO; vazio se ainda nao souber','string') }}"},
 {"name":"type","value":"={{ $fromAI('type','Tipo de imovel, por exemplo apartamento, casa, terreno','string') }}"},
 {"name":"city","value":"={{ $fromAI('city','Cidade desejada','string') }}"},
 {"name":"neighborhood","value":"={{ $fromAI('neighborhood','Bairro desejado','string') }}"},
 {"name":"priceMin","value":"={{ $fromAI('priceMin','Preco minimo em reais; 0 se desconhecido','number') }}"},
 {"name":"priceMax","value":"={{ $fromAI('priceMax','Preco maximo em reais; 0 se desconhecido','number') }}"},
 {"name":"bedroomsMin","value":"={{ $fromAI('bedroomsMin','Quantidade minima de quartos; 0 se desconhecido','number') }}"},
 {"name":"parkingMin","value":"={{ $fromAI('parkingMin','Quantidade minima de vagas; 0 se desconhecido','number') }}"},
 {"name":"limit","value":"={{ $fromAI('limit','Quantidade de resultados, de 1 a 3','number') }}"}
]}
nodes.append(node("Buscar Imoveis","n8n-nodes-base.httpRequestTool",4.3,[180,250],{
 "toolDescription":"Busca somente imoveis reais e disponiveis do tenant atual. Use no maximo 3 resultados. Nunca invente um imovel fora desta tool.",
 "method":"POST","url":"={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/properties/search' }}",
 "sendHeaders":True,"headerParameters":headers,"sendBody":True,"bodyParameters":search_body,"options":{}
}))
qualify_body={"parameters":[
 {"name":"operation","value":"={{ $fromAI('operation','VENDA ou LOCACAO; vazio se nao souber','string') }}"},
 {"name":"desiredType","value":"={{ $fromAI('desiredType','Tipo de imovel desejado','string') }}"},
 {"name":"city","value":"={{ $fromAI('city','Cidade desejada','string') }}"},
 {"name":"neighborhood","value":"={{ $fromAI('neighborhood','Bairro desejado','string') }}"},
 {"name":"bedroomsMin","value":"={{ $fromAI('bedroomsMin','Quartos minimos; 0 se desconhecido','number') }}"},
 {"name":"parkingMin","value":"={{ $fromAI('parkingMin','Vagas minimas; 0 se desconhecido','number') }}"},
 {"name":"budgetMin","value":"={{ $fromAI('budgetMin','Orcamento minimo; 0 se desconhecido','number') }}"},
 {"name":"budgetMax","value":"={{ $fromAI('budgetMax','Orcamento maximo; 0 se desconhecido','number') }}"},
 {"name":"qualificationStatus","value":"={{ $fromAI('qualificationStatus','NOVO, EM_QUALIFICACAO, QUALIFICADO, FRIO ou DESQUALIFICADO','string') }}"},
 {"name":"score","value":"={{ $fromAI('score','Score de 0 a 100; 0 se ainda nao houver base','number') }}"},
 {"name":"summary","value":"={{ $fromAI('summary','Resumo curto do que ja se sabe do lead','string') }}"},
 {"name":"question","value":"={{ $fromAI('question','Pergunta cuja resposta acabou de ser aprendida','string') }}"},
 {"name":"answer","value":"={{ $fromAI('answer','Resposta do cliente para a pergunta','string') }}"},
 {"name":"origin","value":"={{ $fromAI('origin','ESSENCIAL ou QUALIFICATORIA','string') }}"}
]}
nodes.append(node("Salvar Qualificacao","n8n-nodes-base.httpRequestTool",4.3,[390,250],{
 "toolDescription":"Salva informacoes estruturadas e respostas de qualificacao do lead. Use sempre que aprender algo novo relevante.",
 "method":"POST","url":"={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/qualify' }}",
 "sendHeaders":True,"headerParameters":headers,"sendBody":True,"bodyParameters":qualify_body,"options":{}
}))
handoff_body={"parameters":[
 {"name":"reason","value":"={{ $fromAI('reason','Motivo objetivo da transferencia para humano','string') }}"},
 {"name":"summary","value":"={{ $fromAI('summary','Briefing completo para o corretor ou setor humano','string') }}"},
 {"name":"department","value":"={{ $fromAI('department','Setor ou equipe destino; vazio se nao souber','string') }}"},
 {"name":"userMessage","value":"={{ $fromAI('userMessage','Ultima mensagem curta que deve ser enviada ao cliente antes da transferencia','string') }}"}
]}
nodes.append(node("Handoff","n8n-nodes-base.httpRequestTool",4.3,[600,250],{
 "toolDescription":"Transfere o atendimento para humano. Use em pedido de humano, irritacao, assunto financeiro/administrativo/contratual/vistoria/manutencao, ou quando o lead estiver pronto apos qualificacao e apresentacao do imovel.",
 "method":"POST","url":"={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/handoff' }}",
 "sendHeaders":True,"headerParameters":headers,"sendBody":True,"bodyParameters":handoff_body,"options":{}
}))
cancel_body={"parameters":[{"name":"reason","value":"={{ $fromAI('reason','Motivo do cancelamento: desinteresse explicito, opt-out ou lead ja resolveu','string') }}"}]}
nodes.append(node("Cancelar Follow-up","n8n-nodes-base.httpRequestTool",4.3,[810,250],{
 "toolDescription":"Cancela follow-ups e reengajamentos pendentes quando houver desinteresse explicito ou pedido para parar mensagens.",
 "method":"POST","url":"={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/cancel-followup' }}",
 "sendHeaders":True,"headerParameters":headers,"sendBody":True,"bodyParameters":cancel_body,"options":{}
}))
reply_body={"parameters":[{"name":"text","value":"={{ $json.output }}"}]}
nodes.append(node("Responder WhatsApp","n8n-nodes-base.httpRequest",4.3,[150,0],{
 "method":"POST","url":"={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/reply' }}",
 "sendHeaders":True,"headerParameters":headers,"sendBody":True,"bodyParameters":reply_body,"options":{}
}))

connections={
 "Webhook":{"main":[[{"node":"Contexto ImoBia","type":"main","index":0}]]},
 "Contexto ImoBia":{"main":[[{"node":"Preparar Prompt","type":"main","index":0}]]},
 "Preparar Prompt":{"main":[[{"node":"Agente ImoBia","type":"main","index":0}]]},
 "Agente ImoBia":{"main":[[{"node":"Responder WhatsApp","type":"main","index":0}]]},
 "OpenAI Principal":{"ai_languageModel":[[{"node":"Agente ImoBia","type":"ai_languageModel","index":0}]]},
 "OpenAI Fallback":{"ai_languageModel":[[{"node":"Agente ImoBia","type":"ai_languageModel","index":1}]]},
 "Buscar Imoveis":{"ai_tool":[[{"node":"Agente ImoBia","type":"ai_tool","index":0}]]},
 "Salvar Qualificacao":{"ai_tool":[[{"node":"Agente ImoBia","type":"ai_tool","index":0}]]},
 "Handoff":{"ai_tool":[[{"node":"Agente ImoBia","type":"ai_tool","index":0}]]},
 "Cancelar Follow-up":{"ai_tool":[[{"node":"Agente ImoBia","type":"ai_tool","index":0}]]}
}
workflow={"id":"ImoBiaCore202609","name":"ImoBia — Agent Core","active":False,"nodes":nodes,"connections":connections,
 "settings":{"executionOrder":"v1","callerPolicy":"workflowsFromSameOwner"},"pinData":{},"meta":{"templateCredsSetupCompleted":True},"tags":[]}
Path(__file__).with_name('imobia-agent-core.json').write_text(json.dumps(workflow,ensure_ascii=False,indent=2),encoding='utf-8')
print('generated',len(nodes),'nodes')
