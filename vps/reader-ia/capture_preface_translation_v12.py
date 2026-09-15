from playwright.sync_api import sync_playwright
import json
url='https://portainer.leonardoimobi.com.br/reader/'
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path=chrome,args=['--no-sandbox']); c=b.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True); pg=c.new_page(); hit=[]
 def cb(r):
  if '/api/translate' not in r.url:return
  try:
   req=r.request.post_data_json or {}; txt=req.get('text','')
   if 'Preface' in txt:
    hit.append({'request_head':txt[:700],'engine':r.json().get('engine'),'segments':r.json().get('segments',[])[:5]})
  except Exception as e: pass
 pg.on('response',cb); pg.goto(url,wait_until='domcontentloaded',timeout=60000); pg.wait_for_selector('[data-book-id]',timeout=30000); pg.locator('[data-book-id]').first.click(); pg.wait_for_function("document.getElementById('pageTotal').textContent.includes('834')",timeout=60000); pg.fill('#pageNum','18'); pg.dispatch_event('#pageNum','change'); pg.wait_for_function("document.getElementById('status').textContent.includes('pronta')",timeout=90000); pg.wait_for_timeout(1000); print(json.dumps(hit,ensure_ascii=True)); b.close()