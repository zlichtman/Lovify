import type { MixtapeTrack, SkipRegion, TrackVersion } from "../supabase/api";

/**
 * Merged edit state for a mixtape track: inline overrides > saved version > defaults.
 * Trim is represented implicitly as skip regions at the start/end of the track.
 */
export type EffectiveEdit = {
  skipRegions: SkipRegion[];
  fadeInMs: number;
  fadeOutMs: number;
};

export function resolveEdit(
  mt: Pick<MixtapeTrack, "trimStartMs" | "trimEndMs" | "skipRegions" | "fadeInMs" | "fadeOutMs">,
  version: TrackVersion | null,
  trackDurationMs: number | null = null,
): EffectiveEdit {
  // Inline skip_regions override version; else version; else empty.
  const skipsBase = mt.skipRegions ?? version?.skipRegions ?? [];

  // Legacy trim_start / trim_end (from v1 schema) fold into the skip list.
  const trimStart = mt.trimStartMs ?? version?.trimStartMs ?? 0;
  const trimEnd = mt.trimEndMs ?? version?.trimEndMs ?? null;

  const extra: SkipRegion[] = [];
  if (trimStart > 0) extra.push({ start: 0, end: trimStart });
  if (trimEnd != null && trackDurationMs != null && trimEnd < trackDurationMs) {
    extra.push({ start: trimEnd, end: trackDurationMs });
  }

  return {
    skipRegions: normalizeSkips([...skipsBase, ...extra]),
    fadeInMs: mt.fadeInMs ?? version?.fadeInMs ?? 0,
    fadeOutMs: mt.fadeOutMs ?? version?.fadeOutMs ?? 0,
  };
}

export function normalizeSkips(regions: SkipRegion[]): SkipRegion[] {
  const sorted = [...regions]
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: SkipRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Given current position (ms), an edit, and track duration: decide whether to
 * keep playing, seek past a skip region, or end this track.
 */
export function resolveStep(
  positionMs: number,
  edit: EffectiveEdit,
  durationMs: number,
): { action: "ok" } | { action: "seek"; to: number } | { action: "end" } {
  if (positionMs >= durationMs - 100) return { action: "end" };

  for (const r of edit.skipRegions) {
    if (positionMs >= r.start && positionMs < r.end) {
      if (r.end >= durationMs - 100) return { action: "end" };
      return { action: "seek", to: r.end };
    }
  }
  return { action: "ok" };
}
