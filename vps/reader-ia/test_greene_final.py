from playwright.sync_api import sync_playwright
URL='https://readerpro.lakassessoriadigital.workers.dev/'
CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
def safe(s): return str(s).encode('unicode_escape').decode('ascii')
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path=CHROME,args=['--disable-gpu'])
    pg=b.new_page(viewport={'width':1600,'height':1000})
    trans=[]; tts=[]
    pg.on('request',lambda r: trans.append(r.url) if '/api/translate' in r.url else (tts.append(r.url) if '/api/tts' in r.url else None))
    pg.goto(URL,wait_until='domcontentloaded',timeout=60000)
    pg.wait_for_selector('[data-book-id="greene-48-leis-do-poder-ptbr"]',timeout=30000)
    pg.locator('[data-book-id="greene-48-leis-do-poder-ptbr"]').click()
    pg.wait_for_function("document.getElementById('pageTotal').textContent.includes('158')",timeout=30000)
    pg.locator('#pageNum').fill('12'); pg.locator('#pageNum').press('Enter')
    pg.wait_for_function("document.getElementById('status').textContent.includes('texto original PT-BR')",timeout=30000)
    pg.wait_for_selector('.sentence',timeout=15000)
    txt=pg.locator('#translation').inner_text()
    print('cards=',pg.locator('.bookCard').count(),'pageTotal=',safe(pg.locator('#pageTotal').inner_text()))
    print('status=',safe(pg.locator('#status').inner_text()))
    print('bad_chars=',any(c in txt for c in ['\ufffd','\ufffe','\ufeff','\u00ad']),'translate_requests=',len(trans))
    pg.locator('#play').click(); pg.wait_for_timeout(3500)
    print('play=',safe(pg.locator('#play').inner_text()),'tts=',len(tts),'purple=',pg.locator('.pdfSourceMark').count(),'active=',pg.locator('.sentence.active').count())
    pg.keyboard.press('Space'); pg.wait_for_timeout(250)
    print('after_space=',safe(pg.locator('#play').inner_text()))
    b.close()
