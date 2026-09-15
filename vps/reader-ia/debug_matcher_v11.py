from playwright.sync_api import sync_playwright
import json
url='https://portainer.leonardoimobi.com.br/reader/'
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path=chrome,args=['--no-sandbox'])
    c=b.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True)
    pg=c.new_page(); responses=[]
    def onresp(r):
        if '/api/translate' in r.url:
            try: responses.append(r.json())
            except: pass
    pg.on('response',onresp); pg.goto(url,wait_until='domcontentloaded',timeout=60000)
    pg.wait_for_selector('[data-book-id]',timeout=30000); pg.locator('[data-book-id]').first.click()
    pg.wait_for_function("document.getElementById('pageTotal').textContent.includes('834')",timeout=60000)
    pg.fill('#pageNum','18'); pg.dispatch_event('#pageNum','change')
    pg.wait_for_function("document.getElementById('status').textContent.includes('pronta')",timeout=90000)
    segs=responses[-1].get('segments',[]) if responses else []
    out=pg.evaluate("""async(segs)=>{const doc=await pdfjsLib.getDocument({url:'/reader/api/library/book/kotler-keller-marketing-management-15e-global'}).promise;const p=await doc.getPage(18),content=await p.getTextContent(),v=p.getViewport({scale:377/p.getViewport({scale:1}).width});const norm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').match(/[a-z0-9]+(?:['’][a-z0-9]+)?/g)||[];const flat=[];content.items.forEach((it,itemIndex)=>norm(it.str).forEach(token=>flat.push({token,itemIndex})));let cursor=0,res=[];for(const seg of segs.slice(0,4)){const wanted=norm(seg.source);let best=null;for(let i=cursor;i<flat.length;i++){let wi=0,j=i,matches=0,gaps=0,last=i;while(j<flat.length&&wi<wanted.length&&gaps<=Math.max(3,Math.ceil(wanted.length*.18))){if(flat[j].token===wanted[wi]){matches++;wi++;last=j;}else gaps++;j++;}const coverage=matches/Math.max(1,wanted.length),span=Math.max(1,last-i+1),density=matches/span,score=coverage*.78+density*.22;if((!best||score>best.score)&&coverage>=.82&&density>=.58)best={i,last,score,coverage};if(best?.coverage===1&&best.score>.94)break;}if(!best){res.push({source:seg.source,match:null});continue;}const ids=[...new Set(flat.slice(best.i,best.last+1).map(x=>x.itemIndex))];const its=ids.map(i=>{const it=content.items[i],tx=pdfjsLib.Util.transform(v.transform,it.transform);return{i,str:it.str,tx:[tx[4],tx[5]],tr:it.transform};});res.push({source:seg.source,best,items:its});cursor=best.last+1;}return res;}""",segs)
    print(json.dumps({'segments':segs[:4],'matches':out},ensure_ascii=True)); b.close()