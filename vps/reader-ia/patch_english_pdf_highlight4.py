from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("  const p=await pdf.getPage(n);\n  const content=await p.getTextContent();", "  const p=await pdf.getPage(n);\n  const content=pdfTextContentCache.get(n)||await p.getTextContent();\n  pdfTextContentCache.set(n,content);",1)
needle="async function renderPdfPage(n){"
helper=r'''function refreshSourceRanges(){
  const content=pdfTextContentCache.get(page);
  sourceSentenceRanges=content?buildSourceItemRanges(currentSourceSentences,content.items):[];
  updatePdfSourceHighlight();
}
'''
if needle not in s: raise SystemExit('render needle missing')
s=s.replace(needle,helper+needle,1)
p.write_text(s,encoding='utf-8')
print('extract cache + range refresh patched')