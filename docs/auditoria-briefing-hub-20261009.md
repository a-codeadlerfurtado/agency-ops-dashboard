# Auditoria do Briefing Hub — 09/10/2026

## Escopo
Portal do cliente: Cloudflare Worker `agency-briefing-hub` (`agency-briefing-hub.lakassessoriadigital.workers.dev`). Integração de materiais com Google Drive no projeto Supabase `imobi-pro` (`bfzdetibfcwihfkltbkp`).

## Sintoma
O envio de materiais pela cliente **Silvana Freitas** retornava `CLIENT_FOLDER_NOT_FOUND`.

## Causa raiz
A edge function `agency-ops-client-provisioner` registra a pasta do Google Drive em `agency_ops.client_integrations` com `system = 'DRIVE'`. Já o portal do cliente e o vigia do Drive no n8n (via `raw-material-upload-ingest?mode=bindings`) consultam `agency_ops.client_drive_bindings`. Não existia sincronização entre os registros, provocando a ausência do vínculo esperado pelo upload.

## Recuperação de dados (executada em 09/10/2026)
Conforme a auditoria operacional:
- 15 vínculos em `agency_ops.client_drive_bindings` criados;
- 8 jobs destravados;
- pastas criadas para **Silvana Freitas**, **Adeville Imóveis** e **João Ricardo**;
- após o reparo, 0 clientes ativos sem pasta.

Os números acima descrevem a recuperação pontual já realizada; não resultam desta migration.

## Correção permanente
A migration `supabase/migrations/20261009131000_briefing_hub_sync_drive_binding_trigger.sql` instala a função `agency_ops.tg_sync_drive_binding_from_integration()` e o trigger `trg_sync_drive_binding` em `agency_ops.client_integrations`.

O trigger sincroniza `DRIVE` com `agency_ops.client_drive_bindings` quando uma integração é inserida ou seu `external_id` é alterado, usando a pasta raiz `1-FIIyg51Wbe5GbMXagDcB6XxWhKmdY9A`. Se o vínculo existir e apontar para pasta diferente, o UPSERT atualiza o folder ID e os metadados.

Aplicada no banco em 09/10/2026 e validada pela presença do trigger habilitado. A aplicação direta no Supabase recebeu inicialmente a versão `20261009105044`. O histórico foi alinhado ao arquivo por `supabase migration repair --project-ref bfzdetibfcwihfkltbkp --status applied 20261009131000 --yes` e `supabase migration repair --project-ref bfzdetibfcwihfkltbkp --status reverted 20261009105044 --yes`, sem executar novamente o SQL. O trigger continuou habilitado.

## Limitação de observabilidade
O bloco `exception when others then null` da função foi mantido exatamente como solicitado. Ele impede que falhas de sincronização derrubem a operação original, mas **também silencia erros**. Recomenda-se posteriormente monitorar divergências entre as duas tabelas e exercitar o fluxo de upload ponta a ponta.

## Verificação
```sql
select tgname from pg_trigger
where tgrelid='agency_ops.client_integrations'::regclass;
```

Resultado: `trg_sync_drive_binding`.
