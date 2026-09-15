from playwright.sync_api import sync_playwright
from pathlib import Path
import json,time
url='https://portainer.leonardoimobi.com.br/reader/'
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
shot=r'C:\Users\Adler\Downloads\readerpro-preface18-highlight-v10.png'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path=chrome,args=['--no-sandbox'])
    c=b.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True,user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1')
    pg=c.new_page(); pg.goto(url,wait_until='domcontentloaded',timeout=60000)
    pg.wait_for_selector('[data-book-id]',timeout=30000); pg.locator('[data-book-id]').first.click()
    pg.wait_for_function("document.getElementById('pageTotal').textContent.includes('834')",timeout=60000)
    pg.fill('#pageNum','18'); pg.dispatch_event('#pageNum','change')
    pg.wait_for_function("document.getElementById('status').textContent.includes('pronta')",timeout=90000)
    pg.click('#mobilePlay'); pg.wait_for_timeout(1500); pg.click('#mobilePdf'); pg.wait_for_timeout(800)
    info=pg.evaluate("""()=>{const m=document.querySelector('.pdfSourceMark'),w=document.querySelector('.pdfWrap'),c=document.querySelector('#canvas'); if(!m||!w)return {mark:false,status:document.getElementById('status').textContent}; const r=m.getBoundingClientRect(),wr=w.getBoundingClientRect(); const cs=getComputedStyle(m); return {mark:true,top:r.top-wr.top,height:r.height,rel:(r.top-wr.top)/wr.height,background:cs.backgroundColor,border:cs.borderBottomWidth,wrapH:wr.height,status:document.getElementById('status').textContent,buffer:document.getElementById('bufferBadge').textContent};}""")
    pg.screenshot(path=shot,full_page=True); print(json.dumps(info,ensure_ascii=True)); print(shot); b.close()
