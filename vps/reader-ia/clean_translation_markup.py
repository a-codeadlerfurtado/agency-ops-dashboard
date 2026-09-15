from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
needle='function splitSentences(text){\n'
insert="""function cleanTranslatedText(text){
  return (text||'')
    .replace(/```[\\s\\S]*?```/g,' ')
    .replace(/\\*\\*(.*?)\\*\\*/g,'$1')
    .replace(/__(.*?)__/g,'$1')
    .replace(/^#{1,6}\\s*/gm,'')
    .replace(/^\\s*[-*+]\\s+/gm,'')
    .replace(/[ \\t]+/g,' ')
    .replace(/\\n{3,}/g,'\\n\\n')
    .trim();
}
"""
if insert not in s:s=s.replace(needle,insert+needle,1)
s=s.replace('  currentSentences=splitSentences(text);','  text=cleanTranslatedText(text);\n  currentSentences=splitSentences(text);',1)
p.write_text(s,encoding='utf-8')
print('translation markup cleanup added')