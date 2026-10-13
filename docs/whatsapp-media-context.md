# Contexto de mídias do WhatsApp

## Publicado em 13 de outubro de 2026

- Captura orientada a eventos para todos os grupos registrados como CLIENTE, incluindo grupos secundários.
- Arquivos privados no bucket whatsapp-client-media; mensagem original não é alterada.
- Áudio: transcrição e interpretação em campos separados.
- Imagem: texto extraído, descrição e resumo.
- Vídeo: arquivo preservado e fala transcrita. Cobertura AUDIO_ONLY_NO_VISUAL_ANALYSIS, status PARTIAL. Análise visual ainda não implementada.
- Grupos sem client_id permanecem identificados pelo chat, sem adivinhar o cliente.
- OpsQuestion consulta mídias com autenticação e escopo de carteira. A visão whatsapp_messages_with_context fica disponível ao leitor interno já existente.
- Nenhuma interpretação dispara comandos de agenda, campanha ou mensagens.

## Execução e falhas

Worker serial, lease de 240 segundos, lotes até 4 itens e orçamento de 90 segundos antes de iniciar outro item. Claim usa SKIP LOCKED, recuperação de lease após 5 minutos e até 5 tentativas com backoff. A chegada da mensagem desperta o worker; cron de 2 minutos é somente recuperação da fila.

Limites atuais: 25 MiB por arquivo, 15 minutos para áudio, 5 minutos para vídeo. Arquivos maiores ou formatos não suportados vão para REVIEW. Mídia expirada ou sem URL fica UNAVAILABLE. Histórico enfileirado; processamento não deve ser interpretado como instantâneo.

Auth: segredo do worker interno existente, comparação de tempo constante, nenhuma rota pública de processamento. Download exige HTTPS e hosts observados da Z-API/Backblaze, validando redirecionamentos e limite de bytes.

## Verificação

Áudio real e imagem real processados e arquivados. Vídeo real capturado, ASR executado e cobertura parcial registrada. Novos áudios transcritos via trigger. Resposta 401 sem segredo confirmada. RLS e bucket privado confirmados; anon/authenticated não recebem acesso direto. Tests de escopo aprovados:

node scripts/test-whatsapp-media-context.mjs

Consulta operacional:

select media_type,status,count(*) from agency_ops.whatsapp_media_context group by 1,2;
select message_id,chat_name,sender_name,event_at,media_transcript,media_summary,media_coverage from agency_ops.whatsapp_messages_with_context where media_processing_status in ('DONE','PARTIAL') order by id desc limit 20;

## Limites de interpretação

Transcrição e OCR podem errar. Perguntas, dúvidas e métricas relatadas não confirmam o estado das plataformas. A consulta de mídia recente do OpsQuestion é uma amostra; busca histórica pode usar a visão enriquecida com os mesmos filtros de autorização. Não afirmar ausência de mensagens pelo fato de uma amostra não encontrar conteúdo.

## Próximo componente necessário

Extração de quadros de vídeo em worker com FFmpeg, seguida de análise visual, ou provedor multimodal com vídeo habilitado. Sem esse componente, não afirmar análise visual completa.
