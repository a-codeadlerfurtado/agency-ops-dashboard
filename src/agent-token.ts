import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './config.js';

type AgentClaims = { tenantId: string; conversationId: string; exp: number };

function sign(encoded: string) {
  return createHmac('sha256', env.INTERNAL_AGENT_TOKEN).update(encoded).digest('base64url');
}

export function createAgentToken(tenantId: string, conversationId: string, ttlSeconds = 180) {
  const claims: AgentClaims = { tenantId, conversationId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifyAgentToken(token: string): AgentClaims | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AgentClaims;
    if (!claims.tenantId || !claims.conversationId || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
