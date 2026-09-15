import crypto from 'node:crypto';
import { env } from './config.js';

const service = 's3';
const region = 'us-east-1';
const endpoint = `http://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;

function hash(value: Buffer | string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function hmac(key: Buffer | string, value: string) {
  return crypto.createHmac('sha256', key).update(value).digest();
}
function awsDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, day: iso.slice(0, 8) };
}
function encodePath(path: string) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}
function signingKey(secret: string, day: string) {
  const kDate = hmac(`AWS4${secret}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

type SignedRequest = {
  method: 'GET' | 'PUT' | 'HEAD';
  bucket: string;
  key?: string;
  body?: Buffer;
  contentType?: string;
};

async function s3Fetch(input: SignedRequest) {
  if (!env.MINIO_ACCESS_KEY || !env.MINIO_SECRET_KEY) throw new Error('s3_credentials_missing');
  const path = `/${encodePath(input.bucket)}${input.key ? `/${encodePath(input.key)}` : ''}`;
  const url = new URL(path, endpoint);
  const payload = input.body ?? Buffer.alloc(0);
  const payloadHash = hash(payload);
  const { amz, day } = awsDate();
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz
  };
  if (input.contentType) headers['content-type'] = input.contentType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
  const canonicalRequest = [
    input.method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${hash(canonicalRequest)}`;
  const signature = crypto.createHmac('sha256', signingKey(env.MINIO_SECRET_KEY, day)).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${env.MINIO_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  return fetch(url, {
    method: input.method,
    headers,
    body: input.method === 'GET' || input.method === 'HEAD' ? undefined : (payload as unknown as BodyInit)
  });
}

export async function ensureBucket() {
  const head = await s3Fetch({ method: 'HEAD', bucket: env.MINIO_BUCKET });
  if (head.ok) return;
  if (head.status !== 404) throw new Error(`s3_bucket_head_${head.status}`);
  const created = await s3Fetch({ method: 'PUT', bucket: env.MINIO_BUCKET });
  if (!created.ok && created.status !== 409) throw new Error(`s3_bucket_create_${created.status}`);
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  const res = await s3Fetch({ method: 'PUT', bucket: env.MINIO_BUCKET, key, body, contentType });
  if (!res.ok) throw new Error(`s3_put_${res.status}`);
}

export async function getObject(key: string) {
  const res = await s3Fetch({ method: 'GET', bucket: env.MINIO_BUCKET, key });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`s3_get_${res.status}`);
  return {
    body: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream'
  };
}
