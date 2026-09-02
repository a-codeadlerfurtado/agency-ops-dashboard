import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

let status = 'unknown';
let output = '';
try {
  output = execFileSync('npx', [
    '--yes', 'wrangler@4.41.0', 'versions', 'upload',
    'worker/briefing-target-probe.ts',
    '--name', 'agency-briefing-hub',
    '--compatibility-date', '2026-08-19',
    '--message', 'Non-production identity deployment capability probe 2026-09-02'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  status = 'success';
} catch (error) {
  status = 'failed';
  output = `${error?.stdout || ''}\n${error?.stderr || ''}`;
}
const safe = String(output)
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
  .replace(/[A-Za-z0-9_-]{80,}/g, '[long-value-redacted]')
  .slice(-5000);
const body = JSON.stringify({ probe: 'briefing-hub-target-probe-20260902', status, output: safe });
writeFileSync('worker/briefing-target-probe.ts', `export default { async fetch(){ return new Response(${JSON.stringify(body)}, {headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}}); } };\n`);
console.log(`BRIEFING_TARGET_UPLOAD_STATUS=${status}`);
