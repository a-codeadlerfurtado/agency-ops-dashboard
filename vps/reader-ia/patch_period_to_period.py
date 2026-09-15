from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
start=s.index('function splitSentences(text){')
end=s.index('\n\nfunction renderSentences', start)
new='''function splitSentences(text){
  // Narração: uma unidade completa entre pontuações finais.
  // Quebras de linha do PDF nunca cortam a frase.
  const normalized=String(text||'')
    .replace(/\\s*\\n+\\s*/g,' ')
    .replace(/\\s+/g,' ')
    .trim();
  if(!normalized) return [];
  if(typeof Intl!==\'undefined\' && Intl.Segmenter){
    const seg=new Intl.Segmenter('pt-BR',{granularity:'sentence'});
    return [...seg.segment(normalized)]
      .map(x=>x.segment.trim()).filter(Boolean);
  }
  return (normalized.match(/[^.!?…]+(?:[.!?…]+(?=\\s|$)|$)/g)||[normalized])
    .map(x=>x.trim()).filter(Boolean);
}'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('period-to-period segmentation patched')