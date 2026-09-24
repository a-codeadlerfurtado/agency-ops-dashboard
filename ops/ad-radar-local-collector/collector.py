"""
Radar de Anuncios - coletor local da Meta Ads Library.

Parte da estrategia de coleta via navegador publico. A logica de interceptacao
GraphQL/normalizacao foi adaptada do projeto Sonda Imperial (MIT):
Copyright (c) 2026 SaldanhaC3
https://github.com/SaldanhaC3/sonda-imperial

O coletor nao autentica no Facebook, nao contorna CAPTCHA/checkpoint e nao usa
tokens internos hardcoded. Ele observa apenas respostas carregadas pela pagina
publica da Meta Ads Library no navegador.
"""

import json
import os
import re
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

SUPABASE = os.getenv("SUPABASE_URL", "https://bfzdetibfcwihfkltbkp.supabase.co")
API = os.getenv("RADAR_COLLECTOR_API", SUPABASE + "/functions/v1/agency-ops-ad-radar-local-api")
SECRET_PATH = os.getenv("RADAR_COLLECTOR_TOKEN_FILE", "/run/secrets/radar_collector_token")
POLL_SECONDS = max(10, int(os.getenv("POLL_SECONDS", "20")))
SCRAPE_TIMEOUT = max(30, int(os.getenv("SCRAPE_TIMEOUT", "90")))
MAX_STAGNANT_SCROLLS = 8
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
COOKIE_BUTTON_RE = re.compile(
    r"(recusar cookies opcionais|decline optional cookies|rechazar cookies opcionales"
    r"|permitir todos os cookies|allow all cookies)",
    re.IGNORECASE,
)


def token():
    with open(SECRET_PATH, "r", encoding="utf-8") as f:
        return f.read().strip()


def post(payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        API,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-radar-collector-token": token(),
            "user-agent": "agency-radar-local-collector/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def extract_ads(obj, found=None):
    if found is None:
        found = []
    if isinstance(obj, dict):
        if obj.get("ad_archive_id") and "snapshot" in obj:
            found.append(obj)
        else:
            for value in obj.values():
                extract_ads(value, found)
    elif isinstance(obj, list):
        for value in obj:
            extract_ads(value, found)
    return found


def text_value(value):
    if isinstance(value, dict):
        return value.get("text")
    return value


def epoch_date(value):
    if value in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).strftime("%Y-%m-%d")
    except (ValueError, OSError, OverflowError, TypeError):
        return None


def parse_images(snapshot):
    out = []
    for img in snapshot.get("images") or []:
        if isinstance(img, dict):
            out.append({
                "original_url": img.get("original_image_url"),
                "resized_url": img.get("resized_image_url"),
            })
    return out


def parse_videos(snapshot):
    out = []
    for vid in snapshot.get("videos") or []:
        if isinstance(vid, dict):
            out.append({
                "video_hd_url": vid.get("video_hd_url"),
                "video_sd_url": vid.get("video_sd_url"),
                "video_preview_image_url": vid.get("video_preview_image_url"),
            })
    return out


def score(ad):
    days = 0
    try:
        if ad.get("start_date"):
            start = datetime.strptime(ad["start_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            end = datetime.now(timezone.utc)
            days = max(0, (end - start).days)
    except Exception:
        pass
    variations = int(ad.get("collation_count") or 0)
    platforms = len(ad.get("publisher_platform") or [])
    points = min(days, 180) / 180 * 60 + min(variations, 10) / 10 * 25 + min(platforms, 4) / 4 * 15
    if ad.get("is_active") is False:
        points *= 0.7
    points = round(points)
    tier = "lendario" if points >= 70 else "forte" if points >= 45 else "regular" if points >= 20 else "em teste"
    return points, tier, days


def parse_ad(raw):
    snapshot = raw.get("snapshot") or {}
    images = parse_images(snapshot)
    videos = parse_videos(snapshot)
    cards = []
    for card in snapshot.get("cards") or []:
        if not isinstance(card, dict):
            continue
        if card.get("original_image_url") or card.get("resized_image_url"):
            images.append({
                "original_url": card.get("original_image_url"),
                "resized_url": card.get("resized_image_url"),
            })
        if card.get("video_hd_url") or card.get("video_sd_url"):
            videos.append({
                "video_hd_url": card.get("video_hd_url"),
                "video_sd_url": card.get("video_sd_url"),
                "video_preview_image_url": card.get("video_preview_image_url"),
            })
        cards.append({
            "title": card.get("title"),
            "body": text_value(card.get("body")),
            "caption": card.get("caption"),
            "link_url": card.get("link_url"),
            "cta_text": card.get("cta_text"),
            "cta_type": card.get("cta_type"),
        })

    spend = raw.get("spend")
    if isinstance(spend, dict):
        lo, hi = spend.get("lower_bound"), spend.get("upper_bound")
        spend = f"{lo}-{hi}" if lo and hi else lo or hi

    ad = {
        "ad_archive_id": raw.get("ad_archive_id"),
        "page_name": raw.get("page_name") or snapshot.get("page_name"),
        "page_id": raw.get("page_id") or snapshot.get("page_id"),
        "page_like_count": snapshot.get("page_like_count"),
        "page_categories": snapshot.get("page_categories") or [],
        "page_profile_uri": snapshot.get("page_profile_uri"),
        "page_profile_picture_url": snapshot.get("page_profile_picture_url"),
        "ad_title": text_value(snapshot.get("title")),
        "ad_body": text_value(snapshot.get("body")),
        "ad_caption": snapshot.get("caption"),
        "cta_text": snapshot.get("cta_text"),
        "cta_type": snapshot.get("cta_type"),
        "link_url": snapshot.get("link_url"),
        "link_description": text_value(snapshot.get("link_description")),
        "images": images,
        "videos": videos,
        "cards": cards,
        "impressions": (raw.get("impressions_with_index") or {}).get("impressions_text") if isinstance(raw.get("impressions_with_index"), dict) else raw.get("impressions_text"),
        "spend": spend,
        "reach_estimate": raw.get("reach_estimate"),
        "currency": raw.get("currency") or None,
        "start_date": epoch_date(raw.get("start_date")),
        "end_date": epoch_date(raw.get("end_date")),
        "is_active": raw.get("is_active"),
        "total_active_time": raw.get("total_active_time"),
        "publisher_platform": raw.get("publisher_platform") or raw.get("publisher_platforms") or [],
        "display_format": snapshot.get("display_format"),
        "targeted_or_reached_countries": raw.get("targeted_or_reached_countries") or [],
        "collation_count": raw.get("collation_count"),
        "entity_type": raw.get("entity_type"),
    }
    ad["force_score"], ad["force_tier"], ad["days_running"] = score(ad)
    return ad


def library_url(query):
    params = {
        "active_status": "active",
        "ad_type": "all",
        "country": "BR",
        "q": query,
        "search_type": "keyword_unordered",
        "media_type": "all",
    }
    return "https://www.facebook.com/ads/library/?" + urllib.parse.urlencode(params)


def scrape_query(browser, query, max_results):
    raw_ads = {}

    def ingest_payload(payload):
        for raw in extract_ads(payload):
            ad_id = str(raw.get("ad_archive_id") or "")
            if ad_id and ad_id not in raw_ads:
                raw_ads[ad_id] = raw

    def ingest_text(body):
        try:
            ingest_payload(json.loads(body))
            return
        except Exception:
            pass
        for line in body.splitlines():
            line = line.strip()
            if not line or "ad_archive_id" not in line:
                continue
            try:
                ingest_payload(json.loads(line))
            except Exception:
                pass

    def on_response(response):
        if "/api/graphql/" not in response.url:
            return
        try:
            body = response.text()
        except Exception:
            return
        if "ad_archive_id" in body:
            ingest_text(body)

    context = browser.new_context(
        user_agent=USER_AGENT,
        locale="pt-BR",
        viewport={"width": 1440, "height": 900},
    )
    page = context.new_page()
    page.on("response", on_response)
    url = library_url(query)
    page.goto(url, wait_until="domcontentloaded", timeout=90_000)
    if "/login" in page.url or "/checkpoint" in page.url:
        context.close()
        raise RuntimeError("META_LOGIN_OR_CHECKPOINT")

    try:
        page.get_by_role("button", name=COOKIE_BUTTON_RE).first.click(timeout=3500)
        page.wait_for_timeout(700)
    except Exception:
        pass

    page.wait_for_timeout(3500)
    try:
        scripts = page.eval_on_selector_all('script[type="application/json"]', "els => els.map(e => e.textContent)")
        for content in scripts:
            if content and "ad_archive_id" in content:
                try:
                    ingest_payload(json.loads(content))
                except Exception:
                    pass
    except Exception:
        pass

    stagnant, last, start = 0, len(raw_ads), time.time()
    while len(raw_ads) < max_results and time.time() - start < SCRAPE_TIMEOUT:
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1500)
        if len(raw_ads) == last:
            stagnant += 1
            if stagnant >= MAX_STAGNANT_SCROLLS:
                break
        else:
            stagnant, last = 0, len(raw_ads)

    context.close()
    return [parse_ad(x) for x in list(raw_ads.values())[:max_results]]


def build_queries(entity, limit):
    name = str(entity.get("canonical_name") or "").strip()
    city = str(entity.get("city") or "").strip()
    maker = str(entity.get("builder") or entity.get("developer") or "").strip()
    values = [name]
    values += [str(x).strip() for x in (entity.get("aliases") or []) if str(x).strip()]
    if name and city:
        values.append(f"{name} {city}")
    if name and maker:
        values.append(f"{name} {maker}")
    out = []
    seen = set()
    for q in values:
        key = q.casefold()
        if q and key not in seen:
            out.append(q)
            seen.add(key)
        if len(out) >= limit:
            break
    return out


def handle_job(job):
    started = time.time()
    run_id = job["run_id"]
    max_queries = max(1, min(int(job.get("max_queries") or 4), 4))
    per_query = max(1, min(int(job.get("max_ads_per_query") or 25), 25))
    queries = build_queries(job.get("entity") or {}, max_queries)
    all_ads = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            for q in queries:
                ads = scrape_query(browser, q, per_query)
                for ad in ads:
                    ad_id = str(ad.get("ad_archive_id") or "")
                    if ad_id:
                        all_ads[ad_id] = ad
        finally:
            browser.close()

    elapsed = int((time.time() - started) * 1000)
    result = post({
        "action": "complete",
        "run_id": run_id,
        "query_count": len(queries),
        "elapsed_ms": elapsed,
        "ads": list(all_ads.values()),
    })
    print(json.dumps({"event": "completed", "run_id": run_id, "queries": len(queries), "ads": len(all_ads), "elapsed_ms": elapsed, "result": result}, ensure_ascii=False), flush=True)


def main():
    print(json.dumps({"event": "collector_started", "api": API, "poll_seconds": POLL_SECONDS}), flush=True)
    while True:
        try:
            response = post({"action": "claim"})
            if response.get("disabled"):
                time.sleep(POLL_SECONDS)
                continue
            job = response.get("job")
            if not job:
                time.sleep(POLL_SECONDS)
                continue
            try:
                handle_job(job)
            except Exception as exc:
                detail = (str(exc) + " | " + traceback.format_exc(limit=2))[:500]
                try:
                    post({
                        "action": "fail",
                        "run_id": job.get("run_id"),
                        "error_code": "LOCAL_BROWSER_COLLECTOR_FAILURE",
                        "error_detail": detail,
                    })
                except Exception:
                    pass
                print(json.dumps({"event": "job_failed", "run_id": job.get("run_id"), "error": str(exc)}, ensure_ascii=False), flush=True)
                time.sleep(10)
        except Exception as exc:
            print(json.dumps({"event": "poll_failed", "error": str(exc)}, ensure_ascii=False), flush=True)
            time.sleep(max(POLL_SECONDS, 30))


if __name__ == "__main__":
    main()
