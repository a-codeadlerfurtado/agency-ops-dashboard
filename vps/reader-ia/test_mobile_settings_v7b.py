from playwright.sync_api import sync_playwright
import json
url='https://portainer.leonardoimobi.com.br/reader/'
ua='Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path=chrome)
    ctx=b.new_context(viewport={'width':393,'height':852},user_agent=ua,has_touch=True,is_mobile=True)
    pg=ctx.new_page(); pg.goto(url,wait_until='networkidle',timeout=90000)
    out={'innerWidth':pg.evaluate('innerWidth'),'scrollWidth':pg.evaluate('document.documentElement.scrollWidth')}
    out['dockCols']=pg.evaluate("getComputedStyle(document.querySelector('.mobileDock')).gridTemplateColumns")
    out['settingsVisible']=pg.locator('#mobileSettings').is_visible()
    pg.locator('[data-book-id]').first.click(); pg.wait_for_selector('.sentence',timeout=90000)
    pg.locator('#mobileSettings').click(); pg.wait_for_selector('#settingsBackdrop.show',timeout=5000)
    out['voiceOptions']=pg.locator('#mobileVoice option').count(); out['rateOptions']=pg.locator('#mobileRate option').count()
    pg.select_option('#mobileRate','1.3'); out['rateSynced']=pg.input_value('#rate')
    pg.locator('#settingsClose').click(); pg.locator('#mobilePdf').click(); pg.locator('#mobilePlay').click()
    pg.wait_for_timeout(12000)
    marks=pg.locator('.pdfSourceMark'); out['marks']=marks.count()
    if marks.count():
        box=marks.first.bounding_box(); out['markHeight']=round(box['height'],2) if box else None
    out['audioStatus']=pg.locator('#bufferBadge').inner_text(); out['playText']=pg.locator('#mobilePlay').inner_text()
    dock=pg.locator('.mobileDock').bounding_box(); out['dockRight']=round(dock['x']+dock['width'],2)
    shot=r'C:\Users\Adler\Downloads\readerpro-mobile-settings-v7.png'; pg.screenshot(path=shot,full_page=False)
    print(json.dumps(out,ensure_ascii=False)); print(shot); b.close()
