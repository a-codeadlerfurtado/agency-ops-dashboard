import copy, json, uuid
from pathlib import Path

root = Path(r'C:\Users\Adler\imobia-platform\n8n')
core_path = root / 'imobia-agent-core.json'
follow_path = root / 'imobia-followup-engine.json'
core = json.loads(core_path.read_text(encoding='utf-8-sig'))
follow = json.loads(follow_path.read_text(encoding='utf-8-sig'))
by = {n['name']: n for n in follow['nodes']}

# Remove prior merged branch so this script is idempotent.
merged_names = {
    'É Followup?', 'Contexto Followup', 'Preparar Followup', 'Agente Followup',
    'Validar Followup', 'Enviar Followup?', 'Enviar Followup', 'Confirmar Skip Followup'
}
core['nodes'] = [n for n in core['nodes'] if n['name'] not in merged_names]
for name in merged_names:
    core['connections'].pop(name, None)

def clone(name, new_name, position):
    node = copy.deepcopy(by[name])
    node['id'] = str(uuid.uuid4())
    node['name'] = new_name
    node['position'] = position
    return node
is_followup = {
    'id': str(uuid.uuid4()), 'name': 'É Followup?',
    'type': 'n8n-nodes-base.if', 'typeVersion': 2.2, 'position': [-760, 0],
    'parameters': {
        'conditions': {
            'options': {'caseSensitive': False, 'leftValue': '', 'typeValidation': 'strict', 'version': 2},
            'conditions': [{
                'id': str(uuid.uuid4()),
                'leftValue': "={{ $('Webhook').item.json.body.eventType || 'agent_turn' }}",
                'rightValue': 'followup',
                'operator': {'type': 'string', 'operation': 'equals'}
            }],
            'combinator': 'and'
        },
        'options': {}
    }
}

fctx = clone('Contexto ImoBia', 'Contexto Followup', [-540, -260])
fctx['parameters']['url'] = "={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/context' }}"
for header in fctx['parameters']['headerParameters']['parameters']:
    if header['name'] == 'Authorization':
        header['value'] = "={{ 'Bearer ' + $('Webhook').item.json.body.agentToken }}"
prep = clone('Preparar Followup', 'Preparar Followup', [-300, -260])
prep['parameters']['jsCode'] = prep['parameters']['jsCode'].replace("$('Webhook Followup')", "$('Webhook')")
agent = clone('Agente Followup', 'Agente Followup', [-40, -260])
valid = clone('Validar Followup', 'Validar Followup', [220, -260])
send_if = clone('Enviar?', 'Enviar Followup?', [440, -260])

send = clone('Enviar Followup', 'Enviar Followup', [660, -330])
send['parameters']['url'] = "={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/followup/send' }}"
for header in send['parameters']['headerParameters']['parameters']:
    if header['name'] == 'Authorization':
        header['value'] = "={{ 'Bearer ' + $('Webhook').item.json.body.agentToken }}"
for body in send['parameters']['bodyParameters']['parameters']:
    if body['name'] == 'scheduledJobId':
        body['value'] = "={{ $('Webhook').item.json.body.scheduledJobId }}"

skip = copy.deepcopy(send)
skip['id'] = str(uuid.uuid4())
skip['name'] = 'Confirmar Skip Followup'
skip['position'] = [660, -180]
skip['parameters']['url'] = "={{ $('Webhook').item.json.body.imobiaBaseUrl + '/v1/internal/followup/skip' }}"
skip['parameters']['bodyParameters']['parameters'] = [
    {'name': 'scheduledJobId', 'value': "={{ $('Webhook').item.json.body.scheduledJobId }}"},
    {'name': 'reason', 'value': '={{ $json.reason || "agent_skip" }}'}
]
core['nodes'].extend([is_followup, fctx, prep, agent, valid, send_if, send, skip])

core['connections']['Webhook'] = {
    'main': [[{'node': 'É Followup?', 'type': 'main', 'index': 0}]]
}
core['connections']['É Followup?'] = {
    'main': [
        [{'node': 'Contexto Followup', 'type': 'main', 'index': 0}],
        [{'node': 'Contexto ImoBia', 'type': 'main', 'index': 0}]
    ]
}
core['connections']['Contexto Followup'] = {
    'main': [[{'node': 'Preparar Followup', 'type': 'main', 'index': 0}]]
}
core['connections']['Preparar Followup'] = {
    'main': [[{'node': 'Agente Followup', 'type': 'main', 'index': 0}]]
}
core['connections']['Agente Followup'] = {
    'main': [[{'node': 'Validar Followup', 'type': 'main', 'index': 0}]]
}
core['connections']['Validar Followup'] = {
    'main': [[{'node': 'Enviar Followup?', 'type': 'main', 'index': 0}]]
}
core['connections']['Enviar Followup?'] = {
    'main': [
        [{'node': 'Enviar Followup', 'type': 'main', 'index': 0}],
        [{'node': 'Confirmar Skip Followup', 'type': 'main', 'index': 0}]
    ]
}
for model_name in ('OpenAI Principal', 'OpenAI Fallback'):
    links = core['connections'][model_name]['ai_languageModel'][0]
    links[:] = [link for link in links if link['node'] != 'Agente Followup']
    links.append({'node': 'Agente Followup', 'type': 'ai_languageModel', 'index': 0 if model_name == 'OpenAI Principal' else 1})

core_path.write_text(json.dumps(core, ensure_ascii=False, indent=2), encoding='utf-8')
print('merged followup into core:', len(core['nodes']), 'nodes')
print('workflow id:', core.get('id'))
