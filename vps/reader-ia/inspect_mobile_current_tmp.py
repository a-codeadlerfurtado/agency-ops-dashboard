from playwright.sync_api import sync_playwright
import json
url='https://readerpro.lakassessoriadigital.workers.dev/'
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path=chrome)
 ctx=b.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True)
 pg=ctx.new_page(); pg.goto(url,wait_until='domcontentloaded',timeout=60000); pg.wait_for_timeout(3000)
 def box(s):
  x=pg.locator(s).bounding_box(); return None if not x else {k:round(v,1) for k,v in x.items()}
 out={'innerWidth':pg.evaluate('innerWidth'),'scrollWidth':pg.evaluate('document.documentElement.scrollWidth'),'dock':box('.mobileDock'),'play':box('#mobilePlay'),'settings':box('#mobileSettings'),'main':box('.main')}
 pg.screenshot(path=r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\mobile-current.png')
 print(json.dumps(out,ensure_ascii=False)); b.close()