import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { decryptSecret } from './crypto.js';

function privateIpv4(ip: string) {
  const p=ip.split('.').map(Number);
  if (p.length!==4 || p.some(Number.isNaN)) return false;
  return p[0]===10 || p[0]===127 ||
    (p[0]===169 && p[1]===254) ||
    (p[0]===172 && p[1]>=16 && p[1]<=31) ||
    (p[0]===192 && p[1]===168) || p[0]===0;
}

function privateIp(ip: string) {
  if (isIP(ip)===4) return privateIpv4(ip);
  const v=ip.toLowerCase();
  return v==='::1' || v==='::' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd');
}

export async function assertSafeRemoteUrl(raw: string, allowHttp=false) {
  const url=new URL(raw);
  if (url.protocol!=='https:' && !(allowHttp && url.protocol==='http:')) throw new Error('integration_url_protocol_not_allowed');
  if (['localhost','metadata.google.internal'].includes(url.hostname.toLowerCase())) throw new Error('integration_url_host_blocked');
  const addresses=await lookup(url.hostname,{all:true});
  if (!addresses.length || addresses.some((x)=>privateIp(x.address))) throw new Error('integration_url_private_address');
  return url;
}
export function secretHeaders(value: Buffer | null | undefined) {
  if (!value) return {} as Record<string,string>;
  try {
    const parsed=JSON.parse(decryptSecret(value));
    const headers=parsed?.headers;
    if (!headers || typeof headers!=='object' || Array.isArray(headers)) return {};
    const out: Record<string,string>={};
    for (const [k,v] of Object.entries(headers)) {
      if (typeof v!=='string') continue;
      if (/^(host|content-length|connection)$/i.test(k)) continue;
      out[k]=v;
    }
    return out;
  } catch { return {}; }
}

export function getPath(obj: any, path?: string | string[] | null): any {
  if (!path) return undefined;
  const options=Array.isArray(path)?path:[path];
  for (const candidate of options) {
    let cur=obj;
    for (const raw of candidate.split('.')) {
      if (cur==null) break;
      const key=Object.keys(cur).find((k)=>k===raw || k.split(':').pop()===raw);
      cur=key ? cur[key] : undefined;
    }
    if (cur!==undefined && cur!==null && cur!=='') return cur;
  }
  return undefined;
}
