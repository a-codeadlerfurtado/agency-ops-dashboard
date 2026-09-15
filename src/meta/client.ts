import { META_BASE, env } from '../config.js';

export class MetaError extends Error {
  constructor(public status: number, public payload: unknown) {
    super(`Meta API error ${status}`);
  }
}

async function metaFetch<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${META_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new MetaError(res.status, payload);
  return payload as T;
}

export async function exchangeEmbeddedSignupCode(code: string) {
  if (env.META_BROKER_URL && env.META_BROKER_TOKEN) {
    const res = await fetch(env.META_BROKER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.META_BROKER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ code })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new MetaError(res.status, payload);
    return payload as { access_token: string; token_type?: string; expires_in?: number };
  }
  const url = new URL(`${META_BASE}/oauth/access_token`);
  url.searchParams.set('client_id', env.META_APP_ID);
  url.searchParams.set('client_secret', env.META_APP_SECRET);
  url.searchParams.set('code', code);
  const res = await fetch(url);
  const payload = await res.json();
  if (!res.ok) throw new MetaError(res.status, payload);
  return payload as { access_token: string; token_type?: string; expires_in?: number };
}

export function subscribeWaba(wabaId: string, token: string) {
  return metaFetch<{ success: boolean }>(`/${wabaId}/subscribed_apps`, token, { method: 'POST', body: '{}' });
}

export function registerPhone(phoneNumberId: string, pin: string, token: string) {
  return metaFetch<{ success: boolean }>(`/${phoneNumberId}/register`, token, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', pin })
  });
}

export function getPhone(phoneNumberId: string, token: string) {
  return metaFetch<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  }>(`/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`, token);
}

export function normalizeTemplateStatus(status: unknown) {
  const value = String(status ?? '').toUpperCase();
  if (value === 'APPROVED') return 'APROVADO';
  if (value === 'REJECTED') return 'REJEITADO';
  if (value === 'PAUSED' || value === 'DISABLED') return 'PAUSADO';
  return 'PENDENTE';
}

export async function listTemplates(wabaId: string, token: string) {
  const data: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ fields: 'id,name,status,category,language,components', limit: '100' });
    if (after) qs.set('after', after);
    const result = await metaFetch<{ data?: Array<any>; paging?: { cursors?: { after?: string }; next?: string } }>(
      `/${wabaId}/message_templates?${qs.toString()}`,
      token
    );
    data.push(...(result.data ?? []));
    const nextAfter = result.paging?.cursors?.after;
    if (!result.paging?.next || !nextAfter || nextAfter === after) break;
    after = nextAfter;
  }
  return { data };
}

export function createTemplate(wabaId: string, token: string, body: unknown) {
  return metaFetch<any>(`/${wabaId}/message_templates`, token, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function deleteTemplate(wabaId: string, token: string, name: string) {
  const url = `/${wabaId}/message_templates?name=${encodeURIComponent(name)}`;
  return metaFetch<any>(url, token, { method: 'DELETE' });
}

export function sendText(phoneNumberId: string, token: string, to: string, body: string) {
  return metaFetch<{ messages: Array<{ id: string }> }>(`/${phoneNumberId}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false }
    })
  });
}

export function sendTemplate(
  phoneNumberId: string,
  token: string,
  to: string,
  template: { name: string; language: string; components?: unknown[] }
) {
  return metaFetch<{ messages: Array<{ id: string }> }>(`/${phoneNumberId}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.components ? { components: template.components } : {})
      }
    })
  });
}

export function getMedia(mediaId: string, token: string) {
  return metaFetch<{ id: string; url: string; mime_type?: string; file_size?: number }>(`/${mediaId}`, token);
}
