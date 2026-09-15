import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config.js';

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

new Worker('whatsapp-ingress', async (job) => {
  if (job.name === 'agent_turn') {
    if (!env.N8N_AGENT_WEBHOOK) return;
    const res = await fetch(env.N8N_AGENT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job.data)
    });
    if (!res.ok) throw new Error(`n8n ${res.status}: ${await res.text()}`);
    return;
  }

  if (job.name === 'download_media') {
    // Implementar no worker real:
    // 1) carregar whatsapp_account pelo tenant sob RLS;
    // 2) GET /{media_id} para obter URL temporaria;
    // 3) baixar bytes com Bearer token;
    // 4) salvar no MinIO;
    // 5) atualizar messages.midia_url e midia_mime.
    return;
  }
}, { connection, concurrency: 20 });

