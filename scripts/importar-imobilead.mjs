#!/usr/bin/env node
/**
 * Importa um export .xlsx do Imobilead para uma imobiliaria do Imobi-Board.
 *
 *   node scripts/importar-imobilead.mjs <arquivo.xlsx> --slug <slug>            (so confere)
 *   node scripts/importar-imobilead.mjs <arquivo.xlsx> --slug <slug> --confirmar (grava)
 *
 * O script e fino de proposito: ele le a planilha e entrega lotes de JSON para
 * imobi_board.importar_imobilead, que faz todo o resto dentro do banco, numa
 * transacao por lote. Toda a regra -- deduplicacao de contato, etapa do funil,
 * data de origem, chave idempotente -- mora no SQL, onde da para testar e
 * revisar. Aqui nao ha decisao de negocio nenhuma.
 *
 * Sem --confirmar ele nao grava nada: mostra o destino e o que faria.
 *
 * Precisa das credenciais no ambiente (nunca em linha de comando, que fica no
 * historico do shell):
 *
 *   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/* ----------------------------------------------------------- argumentos --- */
const argv = process.argv.slice(2);
const arquivo = argv.find((a) => !a.startsWith("--"));
const pegar = (nome) => {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : null;
};
const slug = pegar("--slug");
const confirmar = argv.includes("--confirmar");
const LOTE = Number(pegar("--lote") ?? 200);

if (!arquivo || !slug) {
  console.error(
    "uso: node scripts/importar-imobilead.mjs <arquivo.xlsx> --slug <slug-da-imobiliaria> [--confirmar]"
  );
  process.exit(2);
}

const URL_SUPABASE = process.env.SUPABASE_URL;
const CHAVE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_SUPABASE || !CHAVE) {
  console.error(
    "Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.\n" +
      '  $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."'
  );
  process.exit(2);
}

const cor = {
  ok: (t) => `\x1b[32m${t}\x1b[0m`,
  ruim: (t) => `\x1b[31m${t}\x1b[0m`,
  fraco: (t) => `\x1b[90m${t}\x1b[0m`,
  forte: (t) => `\x1b[1m${t}\x1b[0m`,
  alerta: (t) => `\x1b[33m${t}\x1b[0m`,
};

/* ------------------------------------------------------------- planilha --- */
/* Um .xlsx e um zip com XML dentro, e o parse cabe em poucas linhas -- nao
   justifica uma dependencia nova. Precisa dar conta das duas formas que o
   mesmo dado assume: o export direto do Imobilead escreve o texto na propria
   celula, e o arquivo re-salvo pelo Google Sheets troca isso por um indice
   para um dicionario a parte. */
/**
 * Extrai um arquivo de dentro do zip, em Node puro.
 *
 * Sem `tar` e sem dependencia: o tar do Git Bash e GNU e le "C:\..." como
 * host remoto, o do Windows e bsdtar e le zip. Qual dos dois responde depende
 * do PATH de quem roda -- exatamente o tipo de diferenca que so aparece na
 * maquina do outro. zlib ja vem no Node e nao tem essa ambiguidade.
 */
function doZip(buf, alvo, opcional = false) {
  // fim do diretorio central: assinatura 0x06054b50, procurada de tras pra frente
  let fim = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error("Arquivo nao parece um .xlsx (zip sem diretorio central).");

  let p = buf.readUInt32LE(fim + 16);            // inicio do diretorio central
  const quantos = buf.readUInt16LE(fim + 10);

  for (let n = 0; n < quantos; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo   = buf.readUInt16LE(p + 10);
    const tamComp  = buf.readUInt32LE(p + 20);
    const nomeLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comLen   = buf.readUInt16LE(p + 32);
    const offset   = buf.readUInt32LE(p + 42);
    const nome     = buf.toString("utf8", p + 46, p + 46 + nomeLen);

    if (nome === alvo) {
      // o cabecalho local repete os tamanhos de nome/extra, e so eles valem
      const nl = buf.readUInt16LE(offset + 26);
      const el = buf.readUInt16LE(offset + 28);
      const ini = offset + 30 + nl + el;
      const dados = buf.subarray(ini, ini + tamComp);
      return metodo === 0 ? dados : inflateRawSync(dados);
    }
    p += 46 + nomeLen + extraLen + comLen;
  }
  if (opcional) return null;
  throw new Error(`"${alvo}" nao encontrado dentro do .xlsx.`);
}

function lerXlsx(caminho) {
  const buf = readFileSync(caminho);
  const xml = doZip(buf, "xl/worksheets/sheet1.xml").toString("utf8");

  /* Dicionario de strings compartilhadas.
     O export direto do Imobilead traz o texto embutido na celula
     (t="inlineStr"). O mesmo arquivo re-salvo pelo Google Sheets traz um
     indice para xl/sharedStrings.xml (t="s") -- e sem resolver esse indice
     toda coluna de texto volta vazia, sem erro nenhum. */
  const ssBuf = doZip(buf, "xl/sharedStrings.xml", true);
  const compart = [];
  if (ssBuf) {
    for (const si of ssBuf.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const partes = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
      compart.push(desescapar(partes.join("")));
    }
  }

  return interpretar(xml, compart);
}

const desescapar = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

function coluna(ref) {
  const letras = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function interpretar(xml, compart = []) {
  const linhas = [];
  for (const m of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celulas = [];
    for (const c of m[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, ref, attrs, corpo = ""] = c;
      const tipo = (attrs.match(/t="([^"]+)"/) || [])[1];
      let valor = null;
      if (tipo === "inlineStr") {
        const partes = [...corpo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
        valor = partes.length ? desescapar(partes.join("")) : null;
      } else {
        const v = corpo.match(/<v>([\s\S]*?)<\/v>/);
        if (v) {
          if (tipo === "s") valor = compart[Number(v[1])] ?? null;
          else if (tipo === "str") valor = desescapar(v[1]);
          else valor = v[1];
        }
      }
      celulas[coluna(ref)] = valor;
    }
    linhas.push(celulas);
  }
  const cab = (linhas[0] || []).map((h, i) => (h ?? `col${i}`).trim());
  return linhas.slice(1).map((l) => {
    const o = {};
    cab.forEach((h, i) => { o[h] = l[i] ?? null; });
    return o;
  });
}

/* ------------------------------------------------------------ supabase --- */
const cabecalhos = {
  "Content-Type": "application/json",
  "Content-Profile": "imobi_board",
  "Accept-Profile": "imobi_board",
  apikey: CHAVE,
  Authorization: `Bearer ${CHAVE}`,
};

async function rest(caminho, opcoes = {}) {
  const r = await fetch(`${URL_SUPABASE}/rest/v1/${caminho}`, { headers: cabecalhos, ...opcoes });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

/* ---------------------------------------------------------------- main --- */
async function main() {
  const alvo = await rest(`tenants?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug,status`);
  if (!alvo?.length) {
    console.error(cor.ruim(`Nenhuma imobiliaria com slug "${slug}".`));
    process.exit(1);
  }
  if (alvo.length > 1) {
    console.error(cor.ruim(`Slug ambiguo: ${alvo.length} imobiliarias. Abortado.`));
    process.exit(1);
  }
  const t = alvo[0];

  const dados = lerXlsx(arquivo);
  const linhas = dados.map((l) => {
    const [dt, hr] = String(l["Data criação"] ?? "").split(" ");
    const [dia, mes, ano] = (dt ?? "").split("/");
    return {
      nome: (l["Nome"] ?? "").trim(),
      telefone: (l["Telefone"] ?? "").trim(),
      email: (l["E-mail"] ?? "").trim(),
      produto: (l["Produto"] ?? "").trim(),
      campanha: (l["Campanha"] ?? "").trim(),
      corretor: (l["Corretor"] ?? "").trim(),
      status: (l["Status"] ?? "").trim(),
      categoria: (l["Categorias"] ?? "").trim(),
      // o banco converte para o fuso da casa; aqui so reordena os campos
      criado: ano ? `${ano}-${mes}-${dia} ${hr ?? "00:00:00"}` : "",
    };
  });

  const lote = arquivo.split(/[\\/]/).pop().replace(/\.xlsx$/i, "");

  console.log("");
  console.log(cor.forte("Destino"));
  console.log(`  imobiliaria .. ${t.name}`);
  console.log(`  slug ......... ${t.slug}`);
  console.log(`  tenant_id .... ${cor.forte(t.id)}`);
  console.log(`  situacao ..... ${t.status}`);
  console.log("");
  console.log(cor.forte("Arquivo"));
  console.log(`  ${arquivo}`);
  console.log(`  linhas ....... ${linhas.length}`);
  console.log(`  lote ......... ${lote}`);
  console.log("");

  if (!confirmar) {
    console.log(cor.alerta("  Modo conferencia: nada foi gravado."));
    console.log(cor.fraco("  Confira o tenant_id acima e repita com --confirmar."));
    console.log("");
    return;
  }

  const total = { linhas_recebidas: 0, contatos_criados: 0, oportunidades_criadas: 0, ja_existiam: 0 };
  for (let i = 0; i < linhas.length; i += LOTE) {
    const fatia = linhas.slice(i, i + LOTE);
    const r = await rest("rpc/importar_imobilead", {
      method: "POST",
      body: JSON.stringify({ p_tenant: t.id, p_lote: fatia, p_origem: lote }),
    });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
    const feito = Math.min(i + LOTE, linhas.length);
    process.stdout.write(`\r  gravando ... ${feito}/${linhas.length}`);
  }
  console.log("\n");
  console.log(cor.forte("Resultado"));
  console.log(`  linhas lidas ............ ${total.linhas_recebidas}`);
  console.log(`  contatos criados ........ ${total.contatos_criados}`);
  console.log(`  oportunidades criadas ... ${total.oportunidades_criadas}`);
  console.log(`  ja existiam ............. ${total.ja_existiam}`);
  console.log("");
  console.log(cor.ok(`  Tudo em ${t.name} (${t.id}).`));
  console.log("");
}

main().catch((e) => {
  console.error("");
  console.error(cor.ruim("  " + (e?.message ?? String(e))));
  console.error("");
  process.exit(1);
});
