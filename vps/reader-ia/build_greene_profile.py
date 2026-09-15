from pathlib import Path
import json, fitz, tarfile
ROOT=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
PDF=Path(r'C:\Users\Adler\Downloads\_OceanofPDF.com_As_48_leis_do_poder_Portuguese_Edition_-_Roberto_greene.pdf')
meta=json.loads((ROOT/'greene_meta.json').read_text(encoding='utf-8'))
laws=json.loads((ROOT/'greene_laws_raw.json').read_text(encoding='utf-8'))
for x in laws:
    if x['number']==8:x['title']='FAÇA AS PESSOAS VIREM ATÉ VOCÊ - USE UMA ISCA, SE FOR PRECISO'
    if x['number']==45:x.update(title='PREGUE A NECESSIDADE DE MUDANÇA, MAS NÃO MUDE MUITA COISA AO MESMO TEMPO.',pdfPage=154)
profile={'id':'greene-48-leis-do-poder-ptbr','sha256':meta['sha256'],'size':meta['size'],'pageCount':meta['pageCount'],'title':'As 48 Leis do Poder','authors':['Robert Greene','Joost Elffers'],'language':'pt-BR','target':'pt-BR','nativeText':True,'libraryFile':'greene_48_leis_do_poder_ptbr.pdf','coverUrl':'/reader/assets/cover-greene.jpg','prefetchPages':10,'warmSentences':5,'description':'Estratégia, poder, comportamento humano e influência organizados em 48 leis, com exemplos históricos e seções de aplicação e inverso.','chapters':laws,'sectionMarkers':['PREFÁCIO','LEI','PARTE I','PARTE II','O INVERSO'],'speechTerms':{'Robert Greene':'Róbert Grín','Joost Elffers':'Iôst Él-fers','Baltasar Gracián':'Baltazár Gracián','Sun-Tzu':'Sun Tzú','Clausewitz':'Cláuzevitz','Nietzsche':'Nítche','Talleyrand':'Talerrã','P.T. Barnum':'Pê Tê Bárnum'},'readingPolicy':{'nativePortuguese':'no_translation','preserveOriginalPunctuation':True,'joinHyphenatedLineBreaks':True,'lawHeadings':'distinct_pause','partHeadings':'short_pause','inverseHeading':'short_pause','quotes':'natural_pause','pageNumbers':'skip','headersFooters':'skip_repeated','watermarks':'skip','acronyms':'ptbr_humanized'}}
(ROOT/'greene48_profile.json').write_text(json.dumps(profile,ensure_ascii=False,indent=2),encoding='utf-8')
doc=fitz.open(PDF); pix=doc[0].get_pixmap(matrix=fitz.Matrix(1.4,1.4),alpha=False); pix.save(ROOT/'assets'/'cover-greene.jpg')
with tarfile.open(ROOT/'greene-only.tar','w') as tar:tar.add(PDF,arcname='greene_48_leis_do_poder_ptbr.pdf')
print('profile',len(laws),'cover', (ROOT/'assets'/'cover-greene.jpg').stat().st_size,'tar',(ROOT/'greene-only.tar').stat().st_size)