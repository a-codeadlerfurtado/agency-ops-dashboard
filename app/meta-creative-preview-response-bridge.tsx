"use client";

import { useLayoutEffect } from "react";

const TARGET = "/functions/v1/agency-ops-meta-creatives-api";

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function rewriteCreativeResponse(body: any) {
  if (!body || !Array.isArray(body.creatives)) return body;
  return {
    ...body,
    creatives: body.creatives.map((row: any) => {
      const stable = String(row?.image_url || "").trim();
      const transient = String(row?.thumbnail_url || "").trim();
      if (!stable) return row;
      return {
        ...row,
        meta_thumbnail_url: transient || null,
        thumbnail_url: stable,
        image_url: stable,
      };
    }),
  };
}

export default function MetaCreativePreviewResponseBridge() {
  useLayoutEffect(() => {
    const marker = "__agencyMetaPreviewFetchPatched";
    const w = window as typeof window & Record<string, any>;
    if (w[marker]) return;

    const originalFetch = window.fetch.bind(window);
    w[marker] = originalFetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (!requestUrl(input).includes(TARGET)) return response;

      try {
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) return response;
        const body = await response.clone().json();
        const rewritten = rewriteCreativeResponse(body);
        return new Response(JSON.stringify(rewritten), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return response;
      }
    };

    return () => {
      if (w[marker] === originalFetch) {
        window.fetch = originalFetch;
        delete w[marker];
      }
    };
  }, []);

  return null;
}
