import {
  createTimelineShell,
  strategyRanges,
  type DynamicStrategyV3,
  type EditStyle,
  type StageName,
  type TextItem,
  type TimelineEffect,
  type TimelineInput,
  type TimelineSpecV1,
  type TimelineTrack,
  type TransitionSpec,
  type VideoItem,
} from "./timeline.ts";

export interface CreativeDirectorContext {
  jobId: string;
  clientId?: string;
  productId?: string;
  contextVersion?: string;
  strategyVersion?: string;
  strategy: DynamicStrategyV3;
  productContext?: Record<string, unknown>;
  clientContext?: Record<string, unknown>;
  benchmarkContext?: Record<string, unknown>;
  brandProfile?: {
    color_palette?: unknown;
    fonts?: unknown;
    logo_rules?: string | null;
    visual_direction?: string | null;
    asset_links?: unknown;
  };
  inputs: TimelineInput[];
}

interface Range { start: number; end: number }
interface Candidate extends Range {
  assetId: string;
  inputIndex: number;
  score: number;
  reason: string[];
  visualClass?: string;
}

const asNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function asRanges(value: unknown): Range[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (Array.isArray(entry) && entry.length >= 2) {
      const start = asNumber(entry[0], -1), end = asNumber(entry[1], -1);
      return start >= 0 && end > start ? [{ start, end }] : [];
    }
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const start = asNumber(row.start ?? row.from ?? row.start_time ?? row.start_seconds, -1);
    const end = asNumber(row.end ?? row.to ?? row.end_time ?? row.end_seconds, -1);
    return start >= 0 && end > start ? [{ start, end }] : [];
  });
}

function overlapSeconds(a: Range, b: Range): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function analysisRecord(input: TimelineInput): Record<string, unknown> {
  const raw = input.analysis ?? {};
  const nested = raw.analysis_json;
  return nested && typeof nested === "object" ? { ...raw, ...(nested as Record<string, unknown>) } : raw;
}

function sceneRanges(input: TimelineInput): Range[] {
  const analysis = analysisRecord(input);
  const scenes = asRanges(analysis.scenes ?? analysis.scene_ranges ?? analysis.shots ?? analysis.cuts);
  if (scenes.length) return scenes;
  const duration = Math.max(0, asNumber(input.duration, 0));
  if (!duration) return [];
  const black = asRanges(analysis.black_ranges ?? analysis.blackRanges);
  if (!black.length) {
    const step = duration <= 8 ? duration : 3.5;
    const out: Range[] = [];
    for (let start = 0; start < duration - 0.25; start += step) out.push({ start, end: Math.min(duration, start + step) });
    return out;
  }
  const sorted = [...black].sort((a, b) => a.start - b.start);
  const usable: Range[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start - cursor >= 0.4) usable.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (duration - cursor >= 0.4) usable.push({ start: cursor, end: duration });
  return usable;
}

function detectVisualClass(analysis: Record<string, unknown>, index: number): string | undefined {
  const classifications = analysis.visual_classifications ?? analysis.scene_classifications ?? analysis.classifications;
  if (!Array.isArray(classifications)) return undefined;
  const row = classifications[index];
  if (!row || typeof row !== "object") return undefined;
  const data = row as Record<string, unknown>;
  return String(data.label ?? data.class ?? data.room ?? data.scene ?? "") || undefined;
}

function buildCandidates(inputs: TimelineInput[]): Candidate[] {
  const candidates: Candidate[] = [];
  inputs.forEach((input, inputIndex) => {
    const analysis = analysisRecord(input);
    const black = asRanges(analysis.black_ranges ?? analysis.blackRanges);
    const silence = asRanges(analysis.silence_ranges ?? analysis.silenceRanges);
    const motion = asNumber(analysis.motion_score ?? analysis.motionScore, 0.55);
    const density = asNumber(analysis.information_density ?? analysis.informationDensity, 0.5);
    const sharpness = asNumber(analysis.sharpness_score ?? analysis.sharpness, 0.6);
    const exposure = asNumber(analysis.exposure_score ?? analysis.exposure, 0.6);
    sceneRanges(input).forEach((scene, sceneIndex) => {
      const duration = scene.end - scene.start;
      if (duration < 0.4) return;
      const blackOverlap = black.reduce((sum, range) => sum + overlapSeconds(scene, range), 0);
      const silenceOverlap = silence.reduce((sum, range) => sum + overlapSeconds(scene, range), 0);
      const blackRatio = blackOverlap / duration;
      const silenceRatio = silenceOverlap / duration;
      const durationScore = duration >= 0.8 && duration <= 4.5 ? 1 : duration < 0.8 ? 0.5 : 0.7;
      const visualClass = detectVisualClass(analysis, sceneIndex);
      let score = 35 * durationScore + 20 * Math.min(1, Math.max(0, motion)) + 15 * Math.min(1, Math.max(0, density));
      score += 15 * Math.min(1, Math.max(0, sharpness)) + 15 * Math.min(1, Math.max(0, exposure));
      score -= 80 * blackRatio + 15 * silenceRatio;
      if (visualClass && /vista|view|pool|piscina|fachada|exterior|varanda|balcony|living|sala/i.test(visualClass)) score += 9;
      candidates.push({ assetId: input.assetId, inputIndex, start: scene.start, end: scene.end, score, reason: [`scene_${sceneIndex}`, `score_${score.toFixed(1)}`], visualClass });
    });
  });
  return candidates.sort((a, b) => b.score - a.score);
}

function stageShotCount(stage: StageName, duration: number, style: EditStyle): number {
  if (stage === "BRANDED_CLOSE") return 1;
  if (style === "LUXURY_CINEMATIC") return Math.max(1, Math.round(duration / 2.2));
  if (style === "HIGH_ENERGY_REEL") return Math.max(1, Math.round(duration / 0.85));
  if (stage === "VISUAL_HOOK") return duration > 1.4 ? 2 : 1;
  if (stage === "PROPERTY_TOUR") return Math.max(3, Math.round(duration / 1.4));
  return Math.max(1, Math.round(duration / 1.6));
}

function transitionFor(style: EditStyle, index: number): TransitionSpec {
  if (style === "LUXURY_CINEMATIC") return { kind: index % 4 === 0 ? "crossfade" : "match_motion", duration: index % 4 === 0 ? 0.22 : 0.12 };
  if (style === "HIGH_ENERGY_REEL") {
    const kinds: TransitionSpec["kind"][] = ["whip", "zoom", "foreground_wipe", "match_motion"];
    return { kind: kinds[index % kinds.length], duration: 0.12 };
  }
  if (style === "ARCHITECTURAL") return { kind: "match_motion", duration: 0.12 };
  return { kind: index % 5 === 4 ? "crossfade" : "cut", duration: index % 5 === 4 ? 0.16 : 0 };
}

function effectsFor(style: EditStyle, stage: StageName, shotIndex: number): TimelineEffect[] {
  const effects: TimelineEffect[] = [
    { kind: "smart_reframe", enabled: true, provider: "native", params: { target: "salient_subject", aspectRatio: "9:16" } },
    { kind: "color_match", enabled: true, provider: "ffmpeg", intensity: 0.7 },
    { kind: "exposure", enabled: true, provider: "ffmpeg", intensity: 0.45 },
    { kind: "white_balance", enabled: true, provider: "ffmpeg", intensity: 0.4 },
  ];
  if (style === "HIGH_ENERGY_REEL" || (style === "PERFORMANCE_AD" && stage === "VISUAL_HOOK")) {
    effects.push({ kind: "speed_ramp", enabled: true, provider: "ffmpeg", intensity: 0.6, params: { profile: shotIndex % 2 ? "fast_in" : "fast_out" } });
    effects.push({ kind: "motion_blur", enabled: true, provider: "ffmpeg", intensity: 0.45 });
  }
  if (style === "LUXURY_CINEMATIC") effects.push({ kind: "vignette", enabled: true, provider: "ffmpeg", intensity: 0.1 });
  return effects;
}

function candidatePreference(stage: StageName, candidate: Candidate): number {
  const label = candidate.visualClass ?? "";
  if (stage === "VISUAL_HOOK" && /vista|view|pool|piscina|fachada|exterior|varanda|balcony/i.test(label)) return 15;
  if (stage === "PRIMARY_BENEFIT" && /living|sala|suite|suíte|varanda|cozinha|kitchen/i.test(label)) return 8;
  if (stage === "PROPERTY_TOUR") return 2;
  if (stage === "COMMERCIAL_SAFE" && /fachada|exterior|living|sala|vista/i.test(label)) return 5;
  return 0;
}

function pickShots(candidates: Candidate[], stage: StageName, count: number, totalDuration: number, used: Map<string, number>): Candidate[] {
  const ranked = candidates
    .map((candidate) => ({ candidate, adjusted: candidate.score + candidatePreference(stage, candidate) - (used.get(candidate.assetId) ?? 0) * 8 }))
    .sort((a, b) => b.adjusted - a.adjusted);
  const selected: Candidate[] = [];
  for (const row of ranked) {
    if (selected.length >= count) break;
    const candidate = row.candidate;
    const duplicateScene = selected.some((other) => other.assetId === candidate.assetId && Math.abs(other.start - candidate.start) < 0.6);
    if (duplicateScene) continue;
    selected.push(candidate);
    used.set(candidate.assetId, (used.get(candidate.assetId) ?? 0) + 1);
  }
  if (!selected.length && candidates[0]) selected.push(candidates[0]);
  while (selected.length < count && selected.length) selected.push(selected[selected.length % selected.length]);
  return selected.slice(0, Math.max(1, count));
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function money(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);
}

function textForStage(stage: StageName, product: Record<string, unknown>): string | undefined {
  const hook = firstString(product, ["hook", "headline", "chamada", "title", "titulo"]);
  const benefit = firstString(product, ["primary_benefit", "benefit", "diferencial", "differential"]);
  const location = firstString(product, ["location", "localizacao", "bairro", "city", "cidade"]);
  const price = money(product.price ?? product.preco ?? product.valor);
  const bedrooms = firstString(product, ["bedrooms", "quartos", "dormitorios", "suites", "suites_count"]);
  const area = firstString(product, ["area", "area_m2", "metragem"]);
  if (stage === "VISUAL_HOOK") return hook ?? (location ? `Um novo jeito de viver em ${location}` : undefined);
  if (stage === "PRIMARY_BENEFIT") return benefit ?? [bedrooms && `${bedrooms} dormitórios`, area && `${area} m²`].filter(Boolean).join(" • ") || undefined;
  if (stage === "COMMERCIAL_SAFE") return price ? `A partir de ${price}` : location;
  if (stage === "BRANDED_CLOSE") return firstString(product, ["cta", "call_to_action"]) ?? "Agende sua visita";
  return undefined;
}

function brandTokens(ctx: CreativeDirectorContext) {
  const palette = Array.isArray(ctx.brandProfile?.color_palette) ? ctx.brandProfile?.color_palette as unknown[] : [];
  const colors = palette.map(String).filter((value) => /^#[0-9a-f]{6}$/i.test(value));
  const fonts = Array.isArray(ctx.brandProfile?.fonts) ? ctx.brandProfile?.fonts as unknown[] : [];
  return { primary: colors[0] ?? "#FFFFFF", accent: colors[1] ?? "#FD6801", font: String(fonts[0] ?? "Inter") };
}

function addTextTrack(timeline: TimelineSpecV1, ctx: CreativeDirectorContext, ranges: Record<StageName, [number, number]>) {
  const product = ctx.productContext ?? {};
  const brand = brandTokens(ctx);
  const items: TextItem[] = [];
  for (const stage of ["VISUAL_HOOK", "PRIMARY_BENEFIT", "COMMERCIAL_SAFE", "BRANDED_CLOSE"] as StageName[]) {
    const text = textForStage(stage, product);
    if (!text) continue;
    const [from, to] = ranges[stage];
    const isClose = stage === "BRANDED_CLOSE";
    items.push({
      id: `text-${stage.toLowerCase()}`,
      type: "text",
      stage,
      start: from + (stage === "VISUAL_HOOK" ? 0.12 : 0.18),
      duration: Math.max(0.5, to - from - 0.32),
      text,
      fontFamily: brand.font,
      fontSize: isClose ? 72 : stage === "VISUAL_HOOK" ? 76 : 58,
      fontWeight: stage === "VISUAL_HOOK" ? 750 : 650,
      color: "#FFFFFF",
      backgroundColor: stage === "COMMERCIAL_SAFE" ? `${brand.accent}E6` : undefined,
      align: "left",
      x: timeline.safeZone.left + 28,
      y: isClose ? timeline.canvas.height - timeline.safeZone.bottom - 160 : timeline.safeZone.top + (stage === "VISUAL_HOOK" ? 90 : 210),
      maxWidth: timeline.canvas.width - timeline.safeZone.left - timeline.safeZone.right - 56,
      lineHeight: 1.04,
      shadow: { color: "#000000AA", blur: 18, x: 0, y: 6 },
      animationIn: { preset: stage === "VISUAL_HOOK" ? "mask_reveal" : "slide_up", duration: 0.28, easing: "ease_out" },
      animationOut: { preset: "fade", duration: 0.2, easing: "ease_in" },
    });
  }
  if (items.length) timeline.tracks.push({ id: "text-main", kind: "text", name: "Copy / motion graphics", items });
}

export function buildProfessionalTimeline(ctx: CreativeDirectorContext): TimelineSpecV1 {
  const timeline = createTimelineShell({
    jobId: ctx.jobId,
    clientId: ctx.clientId,
    productId: ctx.productId,
    contextVersion: ctx.contextVersion,
    strategyVersion: ctx.strategyVersion,
    strategy: ctx.strategy,
    productContext: ctx.productContext,
    inputs: ctx.inputs,
  });
  const ranges = strategyRanges(ctx.strategy);
  const candidates = buildCandidates(ctx.inputs);
  if (!candidates.length) timeline.metadata.warnings.push("no_analyzed_scene_candidates");
  const used = new Map<string, number>();
  const videoItems: VideoItem[] = [];
  let globalShotIndex = 0;

  for (const stage of ["VISUAL_HOOK", "PRIMARY_BENEFIT", "PROPERTY_TOUR", "COMMERCIAL_SAFE"] as StageName[]) {
    const [stageStart, stageEnd] = ranges[stage];
    const stageDuration = stageEnd - stageStart;
    const count = stageShotCount(stage, stageDuration, timeline.style);
    const shots = pickShots(candidates, stage, count, stageDuration, used);
    const nominal = stageDuration / Math.max(1, shots.length);
    let cursor = stageStart;
    shots.forEach((shot, index) => {
      const remaining = stageEnd - cursor;
      if (remaining <= 0.05) return;
      const duration = index === shots.length - 1 ? remaining : Math.min(nominal, remaining);
      const sourceAvailable = Math.max(0.4, shot.end - shot.start);
      const sourceDuration = Math.min(sourceAvailable, duration * (timeline.style === "HIGH_ENERGY_REEL" ? 1.18 : 1));
      const transition = globalShotIndex > 0 ? transitionFor(timeline.style, globalShotIndex) : undefined;
      videoItems.push({
        id: `shot-${stage.toLowerCase()}-${index + 1}`,
        type: "video",
        assetId: shot.assetId,
        stage,
        start: cursor,
        duration,
        trimIn: shot.start,
        trimOut: Math.min(shot.end, shot.start + sourceDuration),
        speed: sourceDuration / duration,
        fit: "cover",
        volume: 0.22,
        effects: effectsFor(timeline.style, stage, globalShotIndex),
        transitionIn: transition,
      });
      cursor += duration;
      globalShotIndex += 1;
    });
  }

  const [closeStart, closeEnd] = ranges.BRANDED_CLOSE;
  const hero = candidates[0];
  if (hero) {
    videoItems.push({
      id: "shot-branded-close",
      type: "video",
      assetId: hero.assetId,
      stage: "BRANDED_CLOSE",
      start: closeStart,
      duration: closeEnd - closeStart,
      trimIn: hero.start,
      trimOut: Math.min(hero.end, hero.start + (closeEnd - closeStart)),
      fit: "cover",
      volume: 0.15,
      effects: [{ kind: "smart_reframe", enabled: true, provider: "native" }, { kind: "color_match", enabled: true, provider: "ffmpeg", intensity: 0.75 }],
      transitionIn: { kind: "crossfade", duration: 0.25 },
    });
  }

  timeline.tracks.push({ id: "video-main", kind: "video", name: "Main picture", items: videoItems });
  addTextTrack(timeline, ctx, ranges);
  timeline.metadata.warnings.push("ai_vfx_require_provider_before_render");
  return timeline;
}
