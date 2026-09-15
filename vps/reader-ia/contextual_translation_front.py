from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
insert="""function cleanPdfText(text){
  let t=(text||'').replace(/([A-Za-zÀ-ÿ])-\\n(?=[A-Za-zÀ-ÿ])/g,'$1');
  const lines=t.split(/\\n+/).map(x=>x.replace(/\\s+/g,' ').trim()).filter(Boolean);
  const kept=lines.filter(line=>{
    if(/^(?:page|página)?\\s*\\d+(?:\\s*(?:of|de)\\s*\\d+)?$/i.test(line)) return false;
    if(/^(?:https?:\\/\\/|www\\.|file:\\/\\/)/i.test(line)) return false;
    if(/(?:https?:\\/\\/|www\\.|file:\\/\\/)/i.test(line) && line.length<180) return false;
    if(/^\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}(?:[, ]+\\d{1,2}:\\d{2})?$/i.test(line)) return false;
    if(/^[-–—•|_\\s\\d]+$/.test(line) && line.length<20) return false;
    return true;
  });
  return kept.join('\\n').replace(/\\n{3,}/g,'\\n\\n').trim();
}
"""
needle="async function extractPageText(n){"
if needle not in s: raise SystemExit('extract function not found')
s=s.replace(needle,insert+needle,1)
s=s.replace("  out=out.replace(/\\s+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();\n  pageTextCache.set(n,out);", "  out=cleanPdfText(out.replace(/\\s+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim());\n  pageTextCache.set(n,out);",1)
p.write_text(s,encoding='utf-8')
print('PDF text cleaning added')