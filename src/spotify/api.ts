const BASE = "https://api.spotify.com/v1";

function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function fetchJSON<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(token), ...init?.headers } });
  if (!res.ok) {
    const body = await res.text();
    const endpoint = url.replace(BASE, "");
    console.error(`Spotify ${init?.method ?? "GET"} ${endpoint} → ${res.status}:`, body);
    if (res.status === 401) throw new Error("Session expired — please sign in again");
    if (res.status === 403) throw new Error(`Spotify 403 on ${endpoint}: ${body}`);
    throw new Error(`Spotify API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ──

export type SpotifyUser = {
  display_name: string | null;
  id: string;
  email?: string;
  product?: string;
};

export type SpotifyImage = { url: string; height: number | null; width: number | null };

export type SpotifyArtist = { id: string; name: string; uri: string };

export type SpotifyAlbum = {
  id: string;
  name: string;
  images: SpotifyImage[];
  release_date: string;
  uri: string;
};

export type SpotifyTrack = {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  track_number: number;
  preview_url: string | null;
  type?: string; // "track" or "episode"
};

export type SpotifyPlaylist = {
  id: string;
  name: string;
  description: string | null;
  images: SpotifyImage[];
  owner: { id: string; display_name: string | null };
  tracks: { total: number; href: string };
  uri: string;
  public: boolean | null;
  snapshot_id: string;
};

// Raw API response — Spotify uses `track`, `item`, or nested formats
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawPlaylistTrackItem = Record<string, any>;

export type SpotifyPlaylistTrackItem = {
  added_at: string;
  track: SpotifyTrack | null;
};

export type Paged<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
};

// ── Normalize helpers ──

/** Normalize a raw playlist track item — extracts track from any known field */
function normalizePlaylistItem(raw: RawPlaylistTrackItem | null | undefined): SpotifyPlaylistTrackItem | null {
  if (!raw || typeof raw !== "object") return null;

  // The track object could be in: raw.track, raw.item, or raw itself (if flattened)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let t: any = raw.track ?? raw.item ?? null;

  // If neither field has it, check if `raw` itself looks like a track (has uri/name)
  if (!t && raw.uri && raw.name) t = raw;
  if (!t || typeof t !== "object") return null;

  // Must have at least a name to be useful
  if (!t.name) return null;

  return {
    added_at: raw.added_at ?? "",
    track: {
      id: t.id ?? "",
      name: t.name ?? "Unknown",
      uri: t.uri ?? "",
      duration_ms: t.duration_ms ?? 0,
      artists: Array.isArray(t.artists) ? t.artists : [],
      album: t.album ?? { id: "", name: "", images: [], release_date: "", uri: "" },
      track_number: t.track_number ?? 0,
      preview_url: t.preview_url ?? null,
      type: t.type,
    },
  };
}

/** Filter and normalize playlist items from API response */
function normalizePlaylistItems(items: RawPlaylistTrackItem[]): SpotifyPlaylistTrackItem[] {
  const result: SpotifyPlaylistTrackItem[] = [];
  for (const item of items) {
    const normalized = normalizePlaylistItem(item);
    if (normalized) result.push(normalized);
  }
  return result;
}

/** Ensure playlist has safe fields */
function safePlaylist(pl: SpotifyPlaylist | null | undefined): pl is SpotifyPlaylist {
  return !!pl && !!pl.id && !!pl.name;
}

// ── User ──

export async function fetchMe(accessToken: string): Promise<SpotifyUser> {
  return fetchJSON<SpotifyUser>(`${BASE}/me`, accessToken);
}

// ── Top Tracks ──

export type TimeRange = "short_term" | "medium_term" | "long_term";

export async function fetchTopTracks(
  token: string,
  range: TimeRange = "medium_term",
  limit = 50,
): Promise<SpotifyTrack[]> {
  const data = await fetchJSON<Paged<SpotifyTrack>>(
    `${BASE}/me/top/tracks?time_range=${range}&limit=${limit}`,
    token,
  );
  return (data.items ?? []).filter((t) => t && t.id);
}

// ── Playlists ──

export async function fetchMyPlaylists(token: string, limit = 50, offset = 0): Promise<Paged<SpotifyPlaylist>> {
  const data = await fetchJSON<Paged<SpotifyPlaylist>>(
    `${BASE}/me/playlists?limit=${limit}&offset=${offset}`,
    token,
  );
  // Filter out any null/invalid playlists and ensure safe defaults
  data.items = (data.items ?? []).filter(safePlaylist).map((pl) => ({
    ...pl,
    tracks: pl.tracks ?? { total: 0, href: "" },
    owner: pl.owner ?? { id: "unknown", display_name: null },
    images: pl.images ?? [],
    description: pl.description ?? null,
  }));
  return data;
}

async function fetchPlaylistPage(
  token: string,
  playlistId: string,
  limit: number,
  offset: number,
): Promise<{ items: RawPlaylistTrackItem[]; next: string | null }> {
  // Try /items first (new endpoint), fall back to /tracks (deprecated but may still work)
  try {
    return await fetchJSON<{ items: RawPlaylistTrackItem[]; next: string | null }>(
      `${BASE}/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
      token,
    );
  } catch {
    return await fetchJSON<{ items: RawPlaylistTrackItem[]; next: string | null }>(
      `${BASE}/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`,
      token,
    );
  }
}

export async function fetchPlaylistTracks(
  token: string,
  playlistId: string,
  limit = 50,
  offset = 0,
): Promise<SpotifyPlaylistTrackItem[]> {
  const data = await fetchPlaylistPage(token, playlistId, limit, offset);
  return normalizePlaylistItems(data.items ?? []);
}

export async function fetchAllPlaylistTracks(
  token: string,
  playlistId: string,
): Promise<SpotifyPlaylistTrackItem[]> {
  const all: SpotifyPlaylistTrackItem[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPlaylistPage(token, playlistId, 50, offset);
    all.push(...normalizePlaylistItems(data.items ?? []));
    hasMore = !!data.next;
    offset += 50;
  }
  return all;
}

export async function createPlaylist(
  token: string,
  _userId: string,
  name: string,
  description = "",
  isPublic = false,
): Promise<SpotifyPlaylist> {
  return fetchJSON<SpotifyPlaylist>(`${BASE}/me/playlists`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: isPublic }),
  });
}

export async function addTracksToPlaylist(
  token: string,
  playlistId: string,
  uris: string[],
): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    await fetchJSON(`${BASE}/playlists/${playlistId}/items`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
}

export async function reorderPlaylistTracks(
  token: string,
  playlistId: string,
  rangeStart: number,
  insertBefore: number,
  rangeLength = 1,
): Promise<void> {
  await fetchJSON(`${BASE}/playlists/${playlistId}/items`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ range_start: rangeStart, insert_before: insertBefore, range_length: rangeLength }),
  });
}

export async function removeTracksFromPlaylist(
  token: string,
  playlistId: string,
  uris: string[],
): Promise<void> {
  await fetchJSON(`${BASE}/playlists/${playlistId}/items`, token, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: uris.map((uri) => ({ uri })) }),
  });
}

export async function updatePlaylistDetails(
  token: string,
  playlistId: string,
  data: { name?: string; description?: string; public?: boolean },
): Promise<void> {
  await fetch(`${BASE}/playlists/${playlistId}`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Liked Songs (user-library-read / user-library-modify) ──

export type SavedTrack = { added_at: string; track: SpotifyTrack };

/** Page through /me/tracks (max 50/page). Handles 429 Retry-After. */
export async function fetchAllSavedTracks(
  token: string,
  onProgress?: (fetched: number, total: number) => void,
): Promise<SavedTrack[]> {
  const all: SavedTrack[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const url = `${BASE}/me/tracks?limit=50&offset=${offset}`;
    const res = await fetch(url, { headers: headers(token) });
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After") ?? "2");
      await new Promise((r) => setTimeout(r, (retry + 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Liked songs fetch ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Paged<SavedTrack>;
    total = data.total;
    for (const it of data.items ?? []) {
      if (it?.track?.uri && it.track.name) all.push(it);
    }
    onProgress?.(all.length, total);
    if (!data.next || (data.items ?? []).length === 0) break;
    offset += 50;
  }
  return all;
}

/** PUT /me/tracks — save up to 50 ids per call. Returns count saved. */
export async function saveLikedTracks(
  token: string,
  trackIds: string[],
  onProgress?: (saved: number, total: number) => void,
): Promise<number> {
  let saved = 0;
  for (let i = 0; i < trackIds.length; i += 50) {
    const batch = trackIds.slice(i, i + 50);
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${BASE}/me/tracks?ids=${batch.join(",")}`, {
        method: "PUT",
        headers: { ...headers(token), "Content-Type": "application/json" },
      });
      if (res.ok || res.status === 200) { saved += batch.length; break; }
      if (res.status === 429 && attempt < 2) {
        const retry = Number(res.headers.get("Retry-After") ?? "2");
        await new Promise((r) => setTimeout(r, (retry + 1) * 1000));
        continue;
      }
      const body = await res.text();
      throw new Error(`Save liked ${res.status}: ${body}`);
    }
    onProgress?.(saved, trackIds.length);
  }
  return saved;
}

// ── Search ──

export async function searchTracks(
  token: string,
  query: string,
  limit = 10,
): Promise<SpotifyTrack[]> {
  const q = query.trim();
  if (!q) return [];
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 10);
  const params = new URLSearchParams({ q, type: "track", limit: String(safeLimit) });
  const data = await fetchJSON<{ tracks: Paged<SpotifyTrack> }>(
    `${BASE}/search?${params}`,
    token,
  );
  return (data.tracks?.items ?? []).filter((t) => t && t.id);
}

// ── Audio Features ──

export type AudioFeatures = {
  id: string;
  danceability: number;
  energy: number;
  key: number;
  loudness: number;
  mode: number;
  speechiness: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  valence: number;
  tempo: number;
};

export async function fetchAudioFeatures(token: string, ids: string[]): Promise<AudioFeatures[]> {
  const all: AudioFeatures[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await fetchJSON<{ audio_features: (AudioFeatures | null)[] }>(
      `${BASE}/audio-features?ids=${batch.join(",")}`,
      token,
    );
    all.push(...(data.audio_features ?? []).filter((f): f is AudioFeatures => f !== null));
  }
  return all;
}

// ── Helpers ──

export function safeTrack(item: SpotifyPlaylistTrackItem | null | undefined): item is SpotifyPlaylistTrackItem & { track: SpotifyTrack } {
  return !!item && !!item.track && !!item.track.id;
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms) return "0:00";
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function albumArt(images: SpotifyImage[] | undefined | null, size: "small" | "medium" | "large" = "medium"): string | undefined {
  if (!images || !images.length) return undefined;
  if (size === "small") return images[images.length - 1]?.url;
  if (size === "large") return images[0]?.url;
  return images[Math.min(1, images.length - 1)]?.url;
}
