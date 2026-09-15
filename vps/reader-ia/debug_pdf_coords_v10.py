from playwright.sync_api import sync_playwright
import json
url='https://portainer.leonardoimobi.com.br/reader/'
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path=chrome,args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':393,'height':852}); pg.goto(url,wait_until='domcontentloaded',timeout=60000)
    out=pg.evaluate("""async()=>{const doc=await pdfjsLib.getDocument({url:'/reader/api/library/book/kotler-keller-marketing-management-15e-global'}).promise;const p=await doc.getPage(18);const c=await p.getTextContent();const item=c.items.find(x=>String(x.str).trim()==='Preface');const v0=p.getViewport({scale:1}),maxW=377,scale=maxW/v0.width,v=p.getViewport({scale});const tx=pdfjsLib.Util.transform(v.transform,item.transform);return {v0:{w:v0.width,h:v0.height},v:{w:v.width,h:v.height},item:{str:item.str,tr:item.transform,w:item.width,h:item.height},tx};}""")
    print(json.dumps(out)); b.close()