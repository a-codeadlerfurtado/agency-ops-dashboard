#!/usr/bin/env node
/**
 * Deploy do Imobi-Board em staging.
 *
 *   node scripts/deploy-staging.mjs
 *
 * Antes de publicar qualquer coisa, confere que os nomes de destino comecam com
 * `imobi-board`. A conta hospeda Workers de producao sem relacao com este
 * projeto e `wrangler deploy` sobrescreve pelo nome, sem perguntar (spec 116).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIXO = "imobi-board";

const alvos = [
  { dir: join(raiz, "apps", "web"), build: true },
  { dir: join(raiz, "workers", "api"), build: false },
];

function sh(cmd, args, cwd, opts = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: opts.capturar ? "pipe" : "inherit",
    shell: process.platform === "win32",
  });
}

function nomeDoWrangler(dir) {
  const arquivo = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]
    .map((f) => join(dir, f))
    .find(existsSync);
  if (!arquivo) throw new Error(`Sem wrangler config em ${dir}`);

  const bruto = readFileSync(arquivo, "utf8");
  const m = arquivo.endsWith(".toml")
    ? bruto.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
    : bruto.match(/"name"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`Sem "name" em ${arquivo}`);
  return m[1];
}

// ---- 1. autenticacao -------------------------------------------------
try {
  const quem = sh("npx", ["wrangler", "whoami"], raiz, { capturar: true });
  if (/not authenticated/i.test(quem)) throw new Error("sem sessao");
  const conta = quem.match(/([\w.@+-]+@[\w.-]+)/)?.[1] ?? "conta autenticada";
  console.log(`Cloudflare: ${conta}\n`);
} catch {
  console.error(
    "wrangler nao esta autenticado.\n\n" +
      "  npx wrangler login\n\n" +
      "Isso abre o OAuth da Cloudflare no seu navegador. Depois rode este " +
      "script de novo."
  );
  process.exit(1);
}

// ---- 2. trava de nome ------------------------------------------------
for (const alvo of alvos) {
  const nome = nomeDoWrangler(alvo.dir);
  if (!nome.startsWith(PREFIXO)) {
    console.error(
      `RECUSADO: "${nome}" nao comeca com "${PREFIXO}".\n` +
        "Deploy abortado para nao sobrescrever Worker de outro projeto."
    );
    process.exit(1);
  }
  alvo.nome = nome;
}
console.log("Destinos:", alvos.map((a) => a.nome).join(", "), "\n");

// ---- 3. deploy -------------------------------------------------------
for (const alvo of alvos) {
  if (alvo.build) {
    console.log(`\n--- build ${alvo.nome} ---`);
    sh("npx", ["vite", "build"], alvo.dir);
  }
  console.log(`\n--- deploy ${alvo.nome} ---`);
  sh("npx", ["wrangler", "deploy"], alvo.dir);
}

console.log(`
Pronto.

Se o imobi-board-worker ainda nao tem secrets, rode dentro de workers/api:

  npx wrangler secret put SUPABASE_URL
  npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
  npx wrangler secret put AGENCY_BRIDGE_TOKEN

Sem SUPABASE_SERVICE_ROLE_KEY a ingestao e o Workflow de SLA nao funcionam.
`);
