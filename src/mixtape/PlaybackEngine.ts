import { useEffect, useRef } from "react";
import { usePlayer } from "../player/PlayerContext";
import type { Mixtape, TrackVersion } from "../supabase/api";
import { resolveEdit, resolveStep } from "./edits";

/**
 * Drives playback through a mixtape's ordered tracks, applying trim + skip
 * regions via seek() + nextTrack() on the existing Spotify Web Playback SDK.
 *
 * Spotify's SDK gives us position updates via player_state_changed; we poll
 * position once every 250ms and step the engine. Skip region detection uses
 * a small lookahead so we seek just before the region starts, avoiding an
 * audible blip.
 */

type Options = {
  mixtape: Mixtape;
  versions: Map<string, TrackVersion>;     // versionId → version
  durations: Map<string, number>;          // trackUri → duration ms (from cache)
  enabled: boolean;
};

const LOOKAHEAD_MS = 250;

export function usePlaybackEngine({ mixtape, versions, durations, enabled }: Options) {
  const player = usePlayer();
  const lastSeekRef = useRef<{ uri: string; to: number; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!player.currentTrack || player.isPaused) return;

    const uri = player.currentTrack.uri;
    const mt = mixtape.tracks.find((t) => t.trackUri === uri);
    if (!mt) return;
    const version = mt.versionId ? versions.get(mt.versionId) ?? null : null;
    const duration = durations.get(uri) ?? player.currentTrack.duration;
    const edit = resolveEdit(mt, version, duration);

    // Look a bit ahead of current position so the seek lands before the skip starts.
    const lookahead = player.position + LOOKAHEAD_MS;
    const step = resolveStep(lookahead, edit, duration);

    if (step.action === "end") {
      player.nextTrack();
      return;
    }

    if (step.action === "seek") {
      // Debounce: don't re-issue the same seek within 500ms.
      const last = lastSeekRef.current;
      const now = Date.now();
      if (last && last.uri === uri && Math.abs(last.to - step.to) < 50 && now - last.at < 500) return;
      lastSeekRef.current = { uri, to: step.to, at: now };
      player.seek(step.to);
    }
  }, [player.position, player.currentTrack, player.isPaused, mixtape, versions, durations, enabled, player]);
}
