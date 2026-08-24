insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
('campaigns','PERSON','Leonardo Augusto',true,'Direção Comercial: visão executiva de campanhas, sem execução técnica',now()),
('commercial_direction','PERSON','Leonardo Augusto',true,'Central de Direção Comercial: CRM, forecast, reuniões, lead quality, handoff e retenção',now()),
('commercial_direction','ROLE','COMMERCIAL',true,'Central de Direção Comercial',now()),
('campaigns','ROLE','COMMERCIAL',true,'Visão executiva/read-only de campanhas',now()),
('clients','ROLE','COMMERCIAL',true,'Visão executiva de clientes',now()),
('health','ROLE','COMMERCIAL',true,'Saúde e risco para leitura executiva',now()),
('onboarding','ROLE','COMMERCIAL',true,'Acompanhamento read-only de onboarding',now()),
('executive','ROLE','COMMERCIAL',true,'Marca a direção comercial como perfil executivo',now())
on conflict (view_key,scope_type,scope_value) do update
set allowed=excluded.allowed,note=excluded.note,updated_at=now();

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
('work','PERSON','Leonardo Augusto',false,'Sem Central de Trabalho operacional',now()),
('focus','PERSON','Leonardo Augusto',false,'Sem foco do dia operacional',now()),
('team','PERSON','Leonardo Augusto',false,'Sem microgestão individual da equipe',now()),
('clickup','PERSON','Leonardo Augusto',false,'Sem gestão operacional no ClickUp',now()),
('opsperf','PERSON','Leonardo Augusto',false,'Sem desempenho operacional individual',now()),
('creative','PERSON','Leonardo Augusto',false,'Sem fila de execução criativa',now()),
('conversations','PERSON','Leonardo Augusto',false,'Sem leitura de conversas operacionais brutas',now()),
('evidence','PERSON','Leonardo Augusto',false,'Sem evidências operacionais brutas',now()),
('audit','PERSON','Leonardo Augusto',false,'Sem auditoria técnica',now()),
('alerts','PERSON','Leonardo Augusto',false,'Sem central de alertas operacionais',now()),
('diary','PERSON','Leonardo Augusto',false,'Sem diário/TaskLog individual',now()),
('finance','PERSON','Leonardo Augusto',false,'Financeiro continua exclusivo do Adler',now())
on conflict (view_key,scope_type,scope_value) do update
set allowed=excluded.allowed,note=excluded.note,updated_at=now();
