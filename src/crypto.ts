import crypto from 'node:crypto';
import { env } from './config.js';

const key = Buffer.from(env.APP_ENCRYPTION_KEY_B64, 'base64');
if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY_B64 deve decodificar para 32 bytes');

export function encryptSecret(value: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptSecret(value: Buffer): string {
  const iv = value.subarray(0, 12);
  const tag = value.subarray(12, 28);
  const ciphertext = value.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export async function verifyMetaSignature(rawBody: Buffer, signatureHeader?: string | null): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const received = signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;

  if (env.META_APP_SECRET) {
    const expected = crypto.createHmac('sha256', env.META_APP_SECRET).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  }

  if (env.META_BROKER_URL && env.META_BROKER_TOKEN) {
    const url = new URL(env.META_BROKER_URL);
    url.pathname = url.pathname.replace(/\/exchange\/?$/, '/verify-signature');
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.META_BROKER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: signatureHeader, bodyB64: rawBody.toString('base64') })
    });
    if (!res.ok) return false;
    const payload = await res.json().catch(() => ({})) as { valid?: boolean };
    return payload.valid === true;
  }

  return false;
}
