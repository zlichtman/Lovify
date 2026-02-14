import { supabase } from "./client";
import {
  searchTracks as apiSearch,
  fetchAudioFeatures as apiAudioFeatures,
  type SpotifyTrack,
  type AudioFeatures,
  albumArt,
} from "../spotify/api";

export type CachedTrack = {
  uri: string;
  name: string;
  artists: string;
  albumName: string | null;
  albumArtUrl: string | null;
  durationMs: number;
  previewUrl: string | null;
};

export type CachedAudioFeatures = {
  uri: string;
  tempo: number;
  energy: number;
  valence: number;
  danceability: number;
};

function spotifyIdFromUri(uri: string): string {
  return uri.split(":").pop() ?? "";
}

function trackToCached(t: SpotifyTrack): CachedTrack {
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(", "),
    albumName: t.album?.name ?? null,
    albumArtUrl: albumArt(t.album?.images, "medium") ?? null,
    durationMs: t.duration_ms,
    previewUrl: t.preview_url ?? null,
  };
}

async function upsertCachedTracks(tracks: CachedTrack[]): Promise<void> {
  if (!supabase || !tracks.length) return;
  const rows = tracks.map((t) => ({
    uri: t.uri,
    name: t.name,
    artists: t.artists,
    album_name: t.albumName,
    album_art_url: t.albumArtUrl,
    duration_ms: t.durationMs,
    preview_url: t.previewUrl,
  }));
  await supabase.from("cached_tracks").upsert(rows, { onConflict: "uri" });
}

export async function getCachedTracks(uris: string[]): Promise<Map<string, CachedTrack>> {
  const map = new Map<string, CachedTrack>();
  if (!supabase || !uris.length) return map;
  const { data } = await supabase
    .from("cached_tracks")
    .select("uri, name, artists, album_name, album_art_url, duration_ms, preview_url")
    .in("uri", uris);
  for (const r of data ?? []) {
    map.set(r.uri, {
      uri: r.uri,
      name: r.name,
      artists: r.artists,
      albumName: r.album_name,
      albumArtUrl: r.album_art_url,
      durationMs: r.duration_ms,
      previewUrl: r.preview_url,
    });
  }
  return map;
}

/**
 * Search goes through Spotify (search results are inherently dynamic), but
 * each returned track is written to cached_tracks so that playback / mixtape
 * views never need a second API hit for the same URI.
 */
export async function searchAndCache(
  token: string,
  query: string,
): Promise<CachedTrack[]> {
  const tracks = await apiSearch(token, query);
  const cached = tracks.map(trackToCached);
  void upsertCachedTracks(cached);
  return cached;
}

/**
 * Hydrate a list of track URIs — returns cached rows; any misses are fetched
 * from Spotify once, cached, and merged in. Use this on mixtape open.
 */
export async function hydrateTracks(
  getToken: () => Promise<string | null>,
  uris: string[],
): Promise<Map<string, CachedTrack>> {
  const cache = await getCachedTracks(uris);
  const missing = uris.filter((u) => !cache.has(u));
  if (!missing.length) return cache;

  const token = await getToken();
  if (!token) return cache;

  // Spotify /tracks endpoint accepts up to 50 ids per call.
  const ids = missing.map(spotifyIdFromUri).filter(Boolean);
  const fresh: CachedTrack[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(`https://api.spotify.com/v1/tracks?ids=${batch.join(",")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const { tracks } = await res.json() as { tracks: (SpotifyTrack | null)[] };
    for (const t of tracks) if (t) fresh.push(trackToCached(t));
  }
  await upsertCachedTracks(fresh);
  for (const c of fresh) cache.set(c.uri, c);
  return cache;
}

// ── Audio features (tempo / valence / energy for visualizer) ──

export async function getAudioFeaturesCached(
  getToken: () => Promise<string | null>,
  uris: string[],
): Promise<Map<string, CachedAudioFeatures>> {
  const map = new Map<string, CachedAudioFeatures>();
  if (!supabase || !uris.length) return map;

  const { data } = await supabase
    .from("cached_audio_features")
    .select("uri, tempo, energy, valence, danceability")
    .in("uri", uris);

  for (const r of data ?? []) {
    map.set(r.uri, {
      uri: r.uri,
      tempo: r.tempo ?? 120,
      energy: r.energy ?? 0.5,
      valence: r.valence ?? 0.5,
      danceability: r.danceability ?? 0.5,
    });
  }

  const missing = uris.filter((u) => !map.has(u));
  if (!missing.length) return map;

  const token = await getToken();
  if (!token) return map;

  const ids = missing.map(spotifyIdFromUri).filter(Boolean);
  let features: AudioFeatures[] = [];
  try { features = await apiAudioFeatures(token, ids); } catch { return map; }

  const rows = features.map((f) => ({
    uri: `spotify:track:${f.id}`,
    tempo: f.tempo,
    energy: f.energy,
    valence: f.valence,
    danceability: f.danceability,
    acousticness: f.acousticness,
    instrumentalness: f.instrumentalness,
    loudness: f.loudness,
  }));
  if (rows.length) {
    await supabase.from("cached_audio_features").upsert(rows, { onConflict: "uri" });
    for (const r of rows) {
      map.set(r.uri, {
        uri: r.uri,
        tempo: r.tempo,
        energy: r.energy,
        valence: r.valence,
        danceability: r.danceability,
      });
    }
  }
  return map;
}
