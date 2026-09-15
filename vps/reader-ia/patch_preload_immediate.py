from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("try{translated=await callTranslate('editorial',12000);}", "try{translated=await callTranslate('editorial',foreground?12000:20000);}")
old='''    const targetPage=page;\n    const translated=await translatePage(targetPage,{foreground:true});'''
new='''    const targetPage=page;\n    const currentTranslation=translatePage(targetPage,{foreground:true});\n    setTimeout(()=>{if(loadToken===pageLoadToken) warmNextPages(targetPage,10);},250);\n    const translated=await currentTranslation;'''
assert old in s;s=s.replace(old,new)
s=s.replace("    if(loadToken===pageLoadToken) warmNextPages(page,10);\n","")
p.write_text(s,encoding='utf-8');print('immediate 10-page preload enabled')