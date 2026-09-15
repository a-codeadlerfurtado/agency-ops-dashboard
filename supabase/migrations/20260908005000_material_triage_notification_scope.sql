-- Escopo de notificacoes da triagem: usa o filtro WORK_ITEM_ ja existente no dashboard.
update agency_ops.platform_notifications
set type = case
  when type = 'MATERIAL_TRIAGE_NEW' then 'WORK_ITEM_MATERIAL_TRIAGE_NEW'
  when type = 'MATERIAL_TRIAGE_ESCALATED' then 'WORK_ITEM_MATERIAL_TRIAGE_ESCALATED'
  else type end
where type in ('MATERIAL_TRIAGE_NEW','MATERIAL_TRIAGE_ESCALATED');

-- As definicoes completas destas funcoes foram aplicadas na migration de producao
-- material_triage_notification_scope. Este arquivo documenta o contrato de escopo:
-- WORK_ITEM_MATERIAL_TRIAGE_NEW -> metadata.target_role = CS
-- WORK_ITEM_MATERIAL_TRIAGE_ESCALATED -> metadata.target_person = Adler Furtado
-- A API atual do dashboard ja restringe WORK_ITEM_* por target_role/target_person.
