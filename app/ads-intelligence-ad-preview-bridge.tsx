"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type PreviewRow = {
  ad_id: string;
  ad_name?: string | null;
  account_id?: string | null;
  creative_format?: string | null;
  preview_url?: string | null;
  preview_source?: string | null;
};

type HoverPreview = {
  adId: string;
  name: string;
  url: string;
  metaUrl: string;
  format: string;
  source: string;
  left: number;
  top: number;
};

const PREVIEW_API = `${SUPABASE_URL}/functions/v1/agency-ops-ad-preview-api`;
const PREVIEW_CACHE_MS = 5 * 60_000;

function cleanAccount(value: unknown) {
  return String(value || "").trim().replace(/^act_/, "");
}

function metaAdUrl(preview: PreviewRow) {
  const account = cleanAccount(preview.account_id);
  const adId = String(preview.ad_id || "").trim();
  if (!account || !adId) return "";
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(account)}&selected_ad_ids=${encodeURIComponent(adId)}`;
}

function adIdFromRow(row: Element) {
  const smalls = Array.from(row.querySelectorAll("small"));
  for (const small of smalls) {
    const match = String(small.textContent || "").match(/\bID\s+(\d{5,30})\b/i);
    if (match) return match[1];
  }
  return "";
}

export default function AdsIntelligenceAdPreviewBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [hover, setHover] = useState<HoverPreview | null>(null);
  const previewMapRef = useRef<Map<string, PreviewRow>>(new Map());
  const clientRef = useRef("");
  const loadingClientRef = useRef("");
  const cacheRef = useRef<Map<string, { at: number; previews: Map<string, PreviewRow> }>>(new Map());
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const headers = useMemo(() => session?.access_token ? {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
  } : null, [session?.access_token]);

  useEffect(() => {
    if (!headers || typeof window === "undefined") return;
    let scheduled = false;
    let disposed = false;

    const cancelClose = () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };

    const scheduleClose = () => {
      cancelClose();
      closeTimerRef.current = window.setTimeout(() => setHover(null), 130);
    };

    const showPreview = (element: HTMLElement) => {
      cancelClose();
      const adId = String(element.dataset.aiiPreviewAdId || "");
      const preview = previewMapRef.current.get(adId);
      if (!preview?.preview_url) return;
      const metaUrl = metaAdUrl(preview);
      const rect = element.getBoundingClientRect();
      const width = 320;
      const estimatedHeight = 430;
      let left = rect.right + 14;
      if (left + width > window.innerWidth - 12) left = Math.max(12, rect.left - width - 14);
      const top = Math.max(12, Math.min(rect.top - 72, window.innerHeight - estimatedHeight - 12));
      setHover({
        adId,
        name: String(preview.ad_name || `Anúncio ${adId}`),
        url: String(preview.preview_url),
        metaUrl,
        format: String(preview.creative_format || "CRIATIVO"),
        source: String(preview.preview_source || ""),
        left,
        top,
      });
    };

    const decorateRows = () => {
      const root = document.querySelector<HTMLElement>(".ads-intelligence-host.aii-structure-active");
      const adsTab = root?.querySelector<HTMLElement>('[data-aii-structure-tab="ads"].active');
      if (!root || !adsTab) {
        setHover(null);
        return;
      }
      const title = String(root.querySelector(".aii-structure-content h3")?.textContent || "").trim();
      if (title !== "Anúncios") return;

      const rows = root.querySelectorAll<HTMLTableRowElement>(".aii-structure-content .aii-structure-table tbody tr");
      rows.forEach((row) => {
        const adId = adIdFromRow(row);
        if (!adId) return;
        const preview = previewMapRef.current.get(adId);
        if (!preview?.preview_url) return;
        const wrap = row.querySelector<HTMLElement>(".aii-ad-name");
        if (!wrap) return;

        let image = wrap.querySelector<HTMLImageElement>("img");
        if (!image) {
          image = document.createElement("img");
          image.alt = "";
          const placeholder = wrap.querySelector<HTMLElement>(".aii-ad-placeholder");
          if (placeholder) placeholder.replaceWith(image);
          else wrap.prepend(image);
        }

        const stableUrl = String(preview.preview_url || "");
        if (stableUrl && image.src !== stableUrl) image.src = stableUrl;
        image.classList.add("aii-preview-bound");
        image.dataset.aiiPreviewAdId = adId;
        image.title = "Passe o mouse para ver a prévia · clique para abrir no Meta";
        image.tabIndex = 0;
        image.setAttribute("role", "link");
        image.setAttribute("aria-label", `Abrir ${preview.ad_name || "anúncio"} no Meta Ads Manager`);

        if (!image.dataset.aiiPreviewEvents) {
          image.dataset.aiiPreviewEvents = "1";
          image.addEventListener("mouseenter", () => showPreview(image!));
          image.addEventListener("mouseleave", scheduleClose);
          image.addEventListener("focus", () => showPreview(image!));
          image.addEventListener("blur", scheduleClose);
          image.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const currentId = String(image?.dataset.aiiPreviewAdId || "");
            const current = previewMapRef.current.get(currentId);
            const url = current ? metaAdUrl(current) : "";
            if (url) window.open(url, "_blank", "noopener,noreferrer");
          });
          image.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            const currentId = String(image?.dataset.aiiPreviewAdId || "");
            const current = previewMapRef.current.get(currentId);
            const url = current ? metaAdUrl(current) : "";
            if (url) window.open(url, "_blank", "noopener,noreferrer");
          });
        }
      });
    };

    const loadPreviews = async (clientName: string) => {
      if (!clientName || loadingClientRef.current === clientName) return;
      const cached = cacheRef.current.get(clientName);
      if (cached && Date.now() - cached.at < PREVIEW_CACHE_MS) {
        previewMapRef.current = cached.previews;
        clientRef.current = clientName;
        window.requestAnimationFrame(decorateRows);
        return;
      }
      loadingClientRef.current = clientName;
      try {
        const response = await fetch(`${PREVIEW_API}?client_name=${encodeURIComponent(clientName)}`, { headers, cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.ok === false || disposed) return;
        const map = new Map<string, PreviewRow>();
        for (const row of Array.isArray(body?.previews) ? body.previews : []) {
          const adId = String(row?.ad_id || "");
          if (adId) map.set(adId, row as PreviewRow);
        }
        cacheRef.current.set(clientName, { at: Date.now(), previews: map });
        previewMapRef.current = map;
        clientRef.current = clientName;
        window.requestAnimationFrame(decorateRows);
      } finally {
        if (loadingClientRef.current === clientName) loadingClientRef.current = "";
      }
    };

    const scan = () => {
      scheduled = false;
      const root = document.querySelector<HTMLElement>(".ads-intelligence-host.aii-structure-active");
      const adsTab = root?.querySelector<HTMLElement>('[data-aii-structure-tab="ads"].active');
      if (!root || !adsTab) {
        setHover(null);
        return;
      }
      const clientName = String(root.querySelector(".aii-client-hero h2")?.textContent || "").trim();
      if (!clientName) return;
      if (clientRef.current !== clientName || !previewMapRef.current.size) void loadPreviews(clientName);
      else decorateRows();
    };

    const scheduleScan = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(scan);
    };

    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    return () => {
      disposed = true;
      observer.disconnect();
      cancelClose();
    };
  }, [headers]);

  if (!hover || typeof document === "undefined") return null;
  const preview = (
    <a
      className="aii-ad-hover-preview"
      href={hover.metaUrl || undefined}
      target="_blank"
      rel="noreferrer"
      style={{ left: hover.left, top: hover.top }}
      onMouseEnter={() => {
        if (closeTimerRef.current !== null) {
          window.clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
      }}
      onMouseLeave={() => {
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = window.setTimeout(() => setHover(null), 130);
      }}
      onClick={(event) => {
        if (!hover.metaUrl) event.preventDefault();
      }}
    >
      <div className="aii-ad-hover-frame">
        <img src={hover.url} alt={`Prévia de ${hover.name}`} />
        {hover.format.toUpperCase().includes("VÍDEO") || hover.format.toUpperCase().includes("VIDEO") ? <span className="aii-ad-hover-play">▶</span> : null}
      </div>
      <div className="aii-ad-hover-copy">
        <div><b>{hover.name}</b><span>{hover.format}</span></div>
        <em>{hover.metaUrl ? "Clique para abrir este anúncio no Meta ↗" : "Prévia do criativo"}</em>
      </div>
    </a>
  );
  return createPortal(preview, document.body);
}
