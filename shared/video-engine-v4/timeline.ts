export type StageName =
  | "VISUAL_HOOK"
  | "PRIMARY_BENEFIT"
  | "PROPERTY_TOUR"
  | "COMMERCIAL_SAFE"
  | "BRANDED_CLOSE";

export type EditStyle =
  | "LUXURY_CINEMATIC"
  | "HIGH_ENERGY_REEL"
  | "LIFESTYLE"
  | "PERFORMANCE_AD"
  | "ARCHITECTURAL"
  | "LAUNCH"
  | "SOLD_SOCIAL_PROOF";

export type TrackKind = "video" | "image" | "text" | "audio" | "overlay";
export type TransitionKind =
  | "cut"
  | "crossfade"
  | "dip_to_black"
  | "whip"
  | "zoom"
  | "foreground_wipe"
  | "mask_wipe"
  | "match_motion";

export type EffectKind =
  | "stabilize"
  | "lens_correction"
  | "smart_reframe"
  | "speed_ramp"
  | "motion_blur"
  | "color_match"
  | "exposure"
  | "white_balance"
  | "vignette"
  | "sharpen"
  | "tracked_text"
  | "perspective_text"
  | "parallax"
  | "sky_enhance"
  | "day_to_dusk"
  | "screen_replace"
  | "object_cleanup"
  | "virtual_staging";

export interface SafeZone {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TimelineAsset {
  id: string;
  kind: "video" | "image" | "audio" | "logo" | "graphic";
  driveFileId?: string;
  url?: string;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export interface TimelineEffect {
  kind: EffectKind;
  enabled: boolean;
  intensity?: number;
  provider?: "native" | "ffmpeg" | "mediabunny" | "ai";
  params?: Record<string, unknown>;
}

export interface TransitionSpec {
  kind: TransitionKind;
  duration: number;
  params?: Record<string, unknown>;
}

export interface BaseItem {
  id: string;
  start: number;
  duration: number;
  stage?: StageName;
  layer?: number;
  opacity?: number;
}

export interface VideoItem extends BaseItem {
  type: "video";
  assetId: string;
  trimIn: number;
  trimOut: number;
  speed?: number;
  volume?: number;
  crop?: { x: number; y: number; width: number; height: number };
  fit?: "cover" | "contain";
  focalPoint?: { x: number; y: number };
  effects?: TimelineEffect[];
  transitionIn?: TransitionSpec;
  transitionOut?: TransitionSpec;
}

export interface ImageItem extends BaseItem {
  type: "image";
  assetId: string;
  fit?: "cover" | "contain";
  focalPoint?: { x: number; y: number };
  effects?: TimelineEffect[];
  transitionIn?: TransitionSpec;
  transitionOut?: TransitionSpec;
}

export interface TextAnimation {
  preset: "fade" | "slide_up" | "scale" | "tracking" | "mask_reveal" | "type_on";
  duration: number;
  easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
}

export interface TextItem extends BaseItem {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  color: string;
  backgroundColor?: string;
  align?: "left" | "center" | "right";
  x: number;
  y: number;
  maxWidth?: number;
  letterSpacing?: number;
  lineHeight?: number;
  shadow?: { color: string; blur: number; x: number; y: number };
  animationIn?: TextAnimation;
  animationOut?: TextAnimation;
  tracking?: { target: string; mode: "position" | "perspective" };
}

export interface AudioItem extends BaseItem {
  type: "audio";
  assetId: string;
  trimIn: number;
  trimOut: number;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  ducking?: { enabled: boolean; targetDb: number; attackMs: number; releaseMs: number };
  beatSync?: boolean;
  role?: "music" | "voice" | "ambient" | "sfx";
}

export interface OverlayItem extends BaseItem {
  type: "overlay";
  assetId: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  animationIn?: TextAnimation;
  animationOut?: TextAnimation;
}

export type TimelineItem = VideoItem | ImageItem | TextItem | AudioItem | OverlayItem;

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  muted?: boolean;
  locked?: boolean;
  items: TimelineItem[];
}

export interface TimelineSpecV1 {
  version: "timeline-v1";
  jobId: string;
  createdAt: string;
  strategyVersion: string;
  directorVersion: string;
  style: EditStyle;
  canvas: {
    width: number;
    height: number;
    fps: number;
    aspectRatio: "9:16" | "1:1" | "16:9" | "4:5";
    background: string;
  };
  safeZone: SafeZone;
  duration: number;
  assets: TimelineAsset[];
  tracks: TimelineTrack[];
  render: {
    container: "mp4";
    videoCodec: "h264";
    audioCodec: "aac";
    videoBitrateMbps: number;
    audioBitrateKbps: number;
    pixelFormat: "yuv420p";
  };
  metadata: {
    clientId?: string;
    productId?: string;
    contextVersion?: string;
    generatedBy: "creative-director-v4" | "human";
    warnings: string[];
  };
}

export interface DynamicStage {
  name?: string;
  stage?: string;
  from?: number;
  to?: number;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

export interface DynamicStrategyV3 {
  stages?: DynamicStage[];
  target_duration_seconds?: number;
  targetDurationSeconds?: number;
  aspect_ratio?: string;
  aspectRatio?: string;
  safe_zone?: Partial<SafeZone> & { side?: number };
  safeZone?: Partial<SafeZone> & { side?: number };
  hook_style?: string;
  style?: string;
  [key: string]: unknown;
}

export interface TimelineInput {
  assetId: string;
  driveFileId: string;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  analysis?: Record<string, unknown>;
}

const STAGE_ORDER: StageName[] = [
  "VISUAL_HOOK",
  "PRIMARY_BENEFIT",
  "PROPERTY_TOUR",
  "COMMERCIAL_SAFE",
  "BRANDED_CLOSE",
];

const DEFAULT_RANGES: Record<StageName, [number, number]> = {
  VISUAL_HOOK: [0, 1.8],
  PRIMARY_BENEFIT: [1.8, 5.04],
  PROPERTY_TOUR: [5.04, 12.96],
  COMMERCIAL_SAFE: [12.96, 15.84],
  BRANDED_CLOSE: [15.84, 18],
};

export function normalizeStageName(value: unknown): StageName | null {
  const name = String(value ?? "").toUpperCase().trim();
  return STAGE_ORDER.includes(name as StageName) ? (name as StageName) : null;
}

export function strategyRanges(strategy: DynamicStrategyV3): Record<StageName, [number, number]> {
  const ranges = { ...DEFAULT_RANGES };
  for (const raw of strategy.stages ?? []) {
    const name = normalizeStageName(raw.name ?? raw.stage);
    if (!name) continue;
    const from = Number(raw.from ?? raw.start);
    const to = Number(raw.to ?? raw.end);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) ranges[name] = [from, to];
  }
  return ranges;
}

export function strategySafeZone(strategy: DynamicStrategyV3): SafeZone {
  const z = strategy.safe_zone ?? strategy.safeZone ?? {};
  const side = Number(z.side ?? 80);
  return {
    top: Number(z.top ?? 240),
    right: Number(z.right ?? side),
    bottom: Number(z.bottom ?? 320),
    left: Number(z.left ?? side),
  };
}

export function chooseStyle(strategy: DynamicStrategyV3, productContext: Record<string, unknown> = {}): EditStyle {
  const requested = String(strategy.style ?? productContext.edit_style ?? productContext.style ?? "").toUpperCase();
  const allowed: EditStyle[] = ["LUXURY_CINEMATIC","HIGH_ENERGY_REEL","LIFESTYLE","PERFORMANCE_AD","ARCHITECTURAL","LAUNCH","SOLD_SOCIAL_PROOF"];
  if (allowed.includes(requested as EditStyle)) return requested as EditStyle;
  const price = Number(productContext.price ?? productContext.valor ?? productContext.preco ?? 0);
  if (price >= 2_000_000) return "LUXURY_CINEMATIC";
  return "PERFORMANCE_AD";
}

export function createTimelineShell(args: {
  jobId: string;
  clientId?: string;
  productId?: string;
  contextVersion?: string;
  strategyVersion?: string;
  strategy: DynamicStrategyV3;
  productContext?: Record<string, unknown>;
  inputs: TimelineInput[];
}): TimelineSpecV1 {
  const duration = Number(args.strategy.target_duration_seconds ?? args.strategy.targetDurationSeconds ?? 18);
  const assets: TimelineAsset[] = args.inputs.map((input) => ({
    id: input.assetId,
    kind: "video",
    driveFileId: input.driveFileId,
    fileName: input.fileName,
    duration: input.duration,
    width: input.width,
    height: input.height,
    metadata: { analysis: input.analysis ?? {} },
  }));
  return {
    version: "timeline-v1",
    jobId: args.jobId,
    createdAt: new Date().toISOString(),
    strategyVersion: args.strategyVersion ?? "dynamic-strategy-v3",
    directorVersion: "creative-director-v4.0.0",
    style: chooseStyle(args.strategy, args.productContext),
    canvas: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16", background: "#000000" },
    safeZone: strategySafeZone(args.strategy),
    duration,
    assets,
    tracks: [],
    render: { container: "mp4", videoCodec: "h264", audioCodec: "aac", videoBitrateMbps: 12, audioBitrateKbps: 192, pixelFormat: "yuv420p" },
    metadata: { clientId: args.clientId, productId: args.productId, contextVersion: args.contextVersion, generatedBy: "creative-director-v4", warnings: [] },
  };
}

export function validateTimeline(timeline: TimelineSpecV1): string[] {
  const errors: string[] = [];
  if (timeline.version !== "timeline-v1") errors.push("unsupported_version");
  if (!(timeline.duration > 0)) errors.push("invalid_duration");
  if (!(timeline.canvas.width > 0 && timeline.canvas.height > 0 && timeline.canvas.fps > 0)) errors.push("invalid_canvas");
  const assetIds = new Set(timeline.assets.map((asset) => asset.id));
  for (const track of timeline.tracks) {
    for (const item of track.items) {
      if (item.start < 0 || item.duration <= 0 || item.start + item.duration > timeline.duration + 0.05) errors.push(`invalid_item_range:${item.id}`);
      if ((item.type === "video" || item.type === "image" || item.type === "audio" || item.type === "overlay") && !assetIds.has(item.assetId)) errors.push(`missing_asset:${item.id}`);
      if (item.type === "video" && item.trimOut <= item.trimIn) errors.push(`invalid_trim:${item.id}`);
      if (item.type === "text") {
        const minX = timeline.safeZone.left;
        const maxX = timeline.canvas.width - timeline.safeZone.right;
        const minY = timeline.safeZone.top;
        const maxY = timeline.canvas.height - timeline.safeZone.bottom;
        if (item.x < minX || item.x > maxX || item.y < minY || item.y > maxY) errors.push(`text_outside_safe_zone:${item.id}`);
      }
    }
  }
  return errors;
}
