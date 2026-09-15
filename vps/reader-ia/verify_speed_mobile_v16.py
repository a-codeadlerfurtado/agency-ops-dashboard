from playwright.sync_api import sync_playwright
import json,time,urllib.request
base='https://readerpro.lakassessoriadigital.workers.dev'; ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152 Safari/537.36'
text=f'Teste de cache ReaderPro {int(time.time())}.'
def tts():
 data=json.dumps({'text':text,'voice':'pm_jarvis','speed':1}).encode(); req=urllib.request.Request(base+'/reader/api/tts',data=data,headers={'Content-Type':'application/json','User-Agent':ua},method='POST'); t=time.perf_counter()
 with urllib.request.urlopen(req,timeout=90) as r: body=r.read(); return {'status':r.status,'ms':round((time.perf_counter()-t)*1000),'cache':r.headers.get('X-ReaderPro-TTS-Cache'),'bytes':len(body)}
print('tts1',tts()); print('tts2',tts())
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path=chrome); ctx=b.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True,user_agent=ua)
 pg=ctx.new_page(); pg.goto(base,wait_until='domcontentloaded',timeout=60000); pg.wait_for_timeout(2500)
 out={'innerWidth':pg.evaluate('innerWidth'),'scrollWidth':pg.evaluate('document.documentElement.scrollWidth')}
 out['dock']=pg.locator('.mobileDock').bounding_box(); out['libraryZ']=pg.evaluate("getComputedStyle(document.querySelector('.libraryOverlay')).zIndex"); out['dockZ']=pg.evaluate("getComputedStyle(document.querySelector('.mobileDock')).zIndex")
 pg.locator('[data-book-id]').last.click(); pg.wait_for_selector('.sentence',timeout=60000)
 pg.locator('#mobileSettings').click(); pg.wait_for_selector('#settingsBackdrop.show',timeout=5000)
 out['settings']=True; out['voiceOptions']=pg.locator('#mobileVoice option').count(); out['rateOptions']=pg.locator('#mobileRate option').count(); pg.select_option('#mobileRate','1.3'); out['rateSynced']=pg.input_value('#rate'); pg.locator('#settingsClose').click()
 pg.locator('#mobilePdf').click(); pg.wait_for_timeout(700); out['canvas']=pg.locator('#canvas').bounding_box(); out['pdfPane']=pg.locator('#pdfPane').bounding_box(); out['dockRight']=round(out['dock']['x']+out['dock']['width'],1) if out['dock'] else None
 pg.screenshot(path=r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\mobile-v16.png'); print('mobile',json.dumps(out,ensure_ascii=False)); b.close()