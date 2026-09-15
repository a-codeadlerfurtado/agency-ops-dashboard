from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-dashboard-commercial-release')
# Reverte apenas mudancas feitas depois da versao f099 (18:09) e preserva o restante.
p=root/'worker/jarvis/memory.ts'; s=p.read_text(encoding='utf-8')
block='''/** Corrige confusoes recorrentes do STT antes de qualquer roteamento/contexto. */\nexport function normalizarTranscricaoOperacional(valor: unknown): string {\n  return String(valor ?? "")\n    .replace(/\\blitros\\b/giu, "leads")\n    .replace(/\\blitro\\b/giu, "lead");\n}\n\n'''
s=s.replace(block,'').replace('const q = normalizarEntidade(normalizarTranscricaoOperacional(mensagem));','const q = normalizarEntidade(mensagem);',1)
start=s.find('const TOKENS_NAO_ENTIDADE = new Set(['); end=s.find('export function resolverClienteMencionado', start)
if start>=0 and end>start: s=s[:start]+s[end:]
s=s.replace('q.split(" ").filter((t) => t && !TOKENS_NAO_ENTIDADE.has(t))','q.split(" ").filter(Boolean)')
s=s.replace('filter((x) => x.length >= 4 && !TOKENS_NAO_ENTIDADE.has(x))','filter((x) => x.length >= 4)')
s=s.replace('filter((t) => t.length >= 3 && !TOKENS_NAO_ENTIDADE.has(t))','filter((t) => t.length >= 3)')
p.write_text(s,encoding='utf-8')

p=root/'worker/jarvis/intent.ts'; s=p.read_text(encoding='utf-8')
start=s.find('export type JanelaMidia ='); end=s.find('export function contextoDeVocabulario',start)
if start>=0 and end>start: s=s[:start]+s[end:]
p.write_text(s,encoding='utf-8')
p=root/'app/wrapped/story-engine.ts'; s=p.read_text(encoding='utf-8')
try:
    repaired=s.encode('cp1252').decode('utf-8')
    if repaired.count('Ã') < s.count('Ã'): s=repaired
except UnicodeError:
    pass
s=s.replace('  const sourceRaw = p.sources || {};\n  const sources = Object.fromEntries(Object.entries(sourceRaw).filter(([key]) => !["work_items","work_events"].includes(key)));\n  const rankings = p.rankings || {};','  const sources = p.sources || {}, rankings = p.rankings || {};')
s=s.replace('O Wrapped só usa fontes confiáveis disponíveis naquele período. A Central de Trabalho é desconsiderada por política de qualidade; ausência de dado nunca vira zero.','O Wrapped só usa uma métrica quando a fonte existia naquele período. Ausência de dado nunca vira zero.')
p.write_text(s,encoding='utf-8')
print('postprod reversions applied')
