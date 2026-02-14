import { supabase, getSupabaseFunctionsUrl } from "./client";
import { extractStoragePath, deleteStoragePaths } from "./storage";

// ── Types ──

export type SkipRegion = { start: number; end: number };

export type TrackVersion = {
  id: string;
  trackUri: string;
  label: string;
  trimStartMs: number;
  trimEndMs: number | null;
  skipRegions: SkipRegion[];
  fadeInMs: number;
  fadeOutMs: number;
};

export type MixtapeTrack = {
  id: string;
  position: number;
  trackUri: string;
  versionId: string | null;
  trimStartMs: number | null;
  trimEndMs: number | null;
  skipRegions: SkipRegion[] | null;
  fadeInMs: number | null;
  fadeOutMs: number | null;
};

export type MixtapeNote = {
  id: string;
  trackUri: string;
  timestampMs: number;
  durationMs: number;
  text: string;
  color: string;
  emoji: string | null;
  imageUrl: string | null;
  visualType: string | null;
};

export type MixtapeImage = {
  id: string;
  position: number;
  imageUrl: string;
  caption: string | null;
};

export type MixtapeSummary = {
  id: string;
  name: string;
  theme: string;
  message: string;
  recipientName: string | null;
  coverImageUrl: string | null;
  shareToken: string;
  trackCount: number;
  firstTrackArt: string | null;
  createdAt: string;
};

export type Mixtape = {
  id: string;
  userId: string;
  name: string;
  theme: string;
  message: string;
  recipientName: string | null;
  coverImageUrl: string | null;
  backgroundImageUrl: string | null;
  shareToken: string;
  tracks: MixtapeTrack[];
  notes: MixtapeNote[];
  images: MixtapeImage[];
};

// ── Snapshot types (kept for Backupify page) ──

export type LibrarySnapshot = {
  id: string;
  name: string;
  playlistCount: number;
  trackCount: number;
  likedCount: number;
  createdAt: string;
};

export type SnapshotLikedTrack = {
  spotifyTrackUri: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  albumArtUrl: string | null;
  durationMs: number;
  addedAt: string | null;
  position: number;
};

export type SnapshotPlaylist = {
  id: string;
  spotifyPlaylistId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  ownerName: string | null;
  trackCount: number;
};

export type SnapshotTrack = {
  spotifyTrackUri: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  albumArtUrl: string | null;
  durationMs: number;
  position: number;
};

// ── Mixtape list / summary ──

export async function fetchUserMixtapes(userId: string): Promise<MixtapeSummary[]> {
  if (!supabase) return [];
  const { data: mixtapes } = await supabase
    .from("mixtapes")
    .select("id, name, theme, message, recipient_name, cover_image_url, share_token, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (!mixtapes?.length) return [];

  const ids = mixtapes.map((m) => m.id);
  const { data: tracks } = await supabase
    .from("mixtape_tracks")
    .select("mixtape_id, position, track_uri")
    .in("mixtape_id", ids)
    .order("position");

  // Look up first-track art from cache
  const firstUris = new Map<string, string>();
  for (const t of tracks ?? []) if (!firstUris.has(t.mixtape_id)) firstUris.set(t.mixtape_id, t.track_uri);

  const uriList = [...firstUris.values()];
  const artMap = new Map<string, string>();
  if (uriList.length) {
    const { data: cached } = await supabase
      .from("cached_tracks")
      .select("uri, album_art_url")
      .in("uri", uriList);
    for (const c of cached ?? []) if (c.album_art_url) artMap.set(c.uri, c.album_art_url);
  }

  const counts = new Map<string, number>();
  for (const t of tracks ?? []) counts.set(t.mixtape_id, (counts.get(t.mixtape_id) ?? 0) + 1);

  return mixtapes.map((m) => ({
    id: m.id,
    name: m.name ?? "",
    theme: m.theme,
    message: m.message ?? "",
    recipientName: m.recipient_name,
    coverImageUrl: m.cover_image_url,
    shareToken: m.share_token,
    trackCount: counts.get(m.id) ?? 0,
    firstTrackArt: artMap.get(firstUris.get(m.id) ?? "") ?? null,
    createdAt: m.created_at,
  }));
}

// ── Load full mixtape ──

async function loadMixtapeBy(column: "id" | "share_token", value: string): Promise<Mixtape | null> {
  if (!supabase) return null;
  const { data: m } = await supabase
    .from("mixtapes")
    .select("id, user_id, name, theme, message, recipient_name, cover_image_url, background_image_url, share_token")
    .eq(column, value)
    .maybeSingle();
  if (!m) return null;

  const [{ data: tracks }, { data: notes }, { data: images }] = await Promise.all([
    supabase.from("mixtape_tracks")
      .select("id, position, track_uri, version_id, trim_start_ms, trim_end_ms, skip_regions, fade_in_ms, fade_out_ms")
      .eq("mixtape_id", m.id).order("position"),
    supabase.from("mixtape_notes")
      .select("id, track_uri, timestamp_ms, duration_ms, text, color, emoji, image_url, visual_type")
      .eq("mixtape_id", m.id).order("timestamp_ms"),
    supabase.from("mixtape_images")
      .select("id, position, image_url, caption")
      .eq("mixtape_id", m.id).order("position"),
  ]);

  return {
    id: m.id,
    userId: m.user_id,
    name: m.name ?? "",
    theme: m.theme,
    message: m.message ?? "",
    recipientName: m.recipient_name,
    coverImageUrl: m.cover_image_url,
    backgroundImageUrl: m.background_image_url,
    shareToken: m.share_token,
    tracks: (tracks ?? []).map((t) => ({
      id: t.id,
      position: t.position,
      trackUri: t.track_uri,
      versionId: t.version_id,
      trimStartMs: t.trim_start_ms,
      trimEndMs: t.trim_end_ms,
      skipRegions: t.skip_regions ?? null,
      fadeInMs: t.fade_in_ms,
      fadeOutMs: t.fade_out_ms,
    })),
    notes: (notes ?? []).map((n) => ({
      id: n.id,
      trackUri: n.track_uri,
      timestampMs: n.timestamp_ms,
      durationMs: n.duration_ms,
      text: n.text ?? "",
      color: n.color,
      emoji: n.emoji,
      imageUrl: n.image_url,
      visualType: n.visual_type,
    })),
    images: (images ?? []).map((i) => ({
      id: i.id,
      position: i.position,
      imageUrl: i.image_url,
      caption: i.caption,
    })),
  };
}

export const fetchMixtapeById = (id: string) => loadMixtapeBy("id", id);
export const fetchSharedMixtape = (shareToken: string) => loadMixtapeBy("share_token", shareToken);

// ── Save mixtape (insert + replace children; no Spotify writes) ──

export type SaveMixtapeInput = {
  id?: string; // if provided → update
  userId: string;
  name: string;
  theme: string;
  message: string;
  recipientName: string | null;
  coverImageUrl: string | null;
  backgroundImageUrl: string | null;
  tracks: Omit<MixtapeTrack, "id">[];
  notes: Omit<MixtapeNote, "id">[];
  images: Omit<MixtapeImage, "id">[];
};

export async function saveMixtape(input: SaveMixtapeInput): Promise<{ id: string; shareToken: string } | null> {
  if (!supabase) return null;

  const parentRow = {
    user_id: input.userId,
    name: input.name,
    theme: input.theme,
    message: input.message,
    recipient_name: input.recipientName,
    cover_image_url: input.coverImageUrl,
    background_image_url: input.backgroundImageUrl,
    updated_at: new Date().toISOString(),
  };

  let mixtapeId: string;
  let shareToken: string;

  if (input.id) {
    const { data, error } = await supabase
      .from("mixtapes").update(parentRow).eq("id", input.id)
      .select("id, share_token").single();
    if (error || !data) { console.error("Update mixtape failed:", error); return null; }
    mixtapeId = data.id; shareToken = data.share_token;
    // Wipe children to replace
    await Promise.all([
      supabase.from("mixtape_tracks").delete().eq("mixtape_id", mixtapeId),
      supabase.from("mixtape_notes").delete().eq("mixtape_id", mixtapeId),
      supabase.from("mixtape_images").delete().eq("mixtape_id", mixtapeId),
    ]);
  } else {
    const { data, error } = await supabase
      .from("mixtapes").insert(parentRow).select("id, share_token").single();
    if (error || !data) { console.error("Insert mixtape failed:", error); return null; }
    mixtapeId = data.id; shareToken = data.share_token;
  }

  if (input.tracks.length) {
    const rows = input.tracks.map((t) => ({
      mixtape_id: mixtapeId,
      position: t.position,
      track_uri: t.trackUri,
      version_id: t.versionId,
      trim_start_ms: t.trimStartMs,
      trim_end_ms: t.trimEndMs,
      skip_regions: t.skipRegions ?? [],
      fade_in_ms: t.fadeInMs,
      fade_out_ms: t.fadeOutMs,
    }));
    const { error } = await supabase.from("mixtape_tracks").insert(rows);
    if (error) console.error("Insert tracks failed:", error);
  }

  if (input.notes.length) {
    const rows = input.notes.map((n) => ({
      mixtape_id: mixtapeId,
      track_uri: n.trackUri,
      timestamp_ms: n.timestampMs,
      duration_ms: n.durationMs,
      text: n.text,
      color: n.color,
      emoji: n.emoji,
      image_url: n.imageUrl,
      visual_type: n.visualType,
    }));
    const { error } = await supabase.from("mixtape_notes").insert(rows);
    if (error) console.error("Insert notes failed:", error);
  }

  if (input.images.length) {
    const rows = input.images.map((i) => ({
      mixtape_id: mixtapeId,
      position: i.position,
      image_url: i.imageUrl,
      caption: i.caption,
    }));
    const { error } = await supabase.from("mixtape_images").insert(rows);
    if (error) console.error("Insert images failed:", error);
  }

  return { id: mixtapeId, shareToken };
}

export async function deleteMixtape(mixtapeId: string): Promise<boolean> {
  if (!supabase) return false;

  // Gather storage paths before deleting rows.
  const [{ data: mx }, { data: notes }, { data: images }] = await Promise.all([
    supabase.from("mixtapes")
      .select("cover_image_url, background_image_url")
      .eq("id", mixtapeId).maybeSingle(),
    supabase.from("mixtape_notes")
      .select("image_url").eq("mixtape_id", mixtapeId),
    supabase.from("mixtape_images")
      .select("image_url").eq("mixtape_id", mixtapeId),
  ]);

  const urls: string[] = [
    mx?.cover_image_url, mx?.background_image_url,
    ...(notes ?? []).map((n) => n.image_url),
    ...(images ?? []).map((i) => i.image_url),
  ].filter((u): u is string => !!u);

  const paths = urls
    .map(extractStoragePath)
    .filter((p): p is string => !!p);

  const { error } = await supabase.from("mixtapes").delete().eq("id", mixtapeId);
  if (error) { console.error("deleteMixtape:", error); return false; }

  // DB row gone; FK cascade drops tracks/notes/images. Now clean storage.
  if (paths.length) await deleteStoragePaths(paths);

  return true;
}

// ── Track versions ──

export async function fetchTrackVersions(userId: string, trackUri: string): Promise<TrackVersion[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("track_versions")
    .select("id, track_uri, label, trim_start_ms, trim_end_ms, skip_regions, fade_in_ms, fade_out_ms")
    .eq("user_id", userId).eq("track_uri", trackUri)
    .order("created_at", { ascending: false });
  return (data ?? []).map((v) => ({
    id: v.id,
    trackUri: v.track_uri,
    label: v.label,
    trimStartMs: v.trim_start_ms,
    trimEndMs: v.trim_end_ms,
    skipRegions: v.skip_regions ?? [],
    fadeInMs: v.fade_in_ms,
    fadeOutMs: v.fade_out_ms,
  }));
}

export async function saveTrackVersion(
  userId: string,
  v: Omit<TrackVersion, "id"> & { id?: string },
): Promise<TrackVersion | null> {
  if (!supabase) return null;
  const row = {
    user_id: userId,
    track_uri: v.trackUri,
    label: v.label,
    trim_start_ms: v.trimStartMs,
    trim_end_ms: v.trimEndMs,
    skip_regions: v.skipRegions,
    fade_in_ms: v.fadeInMs,
    fade_out_ms: v.fadeOutMs,
  };
  const q = v.id
    ? supabase.from("track_versions").update(row).eq("id", v.id).select().single()
    : supabase.from("track_versions").insert(row).select().single();
  const { data, error } = await q;
  if (error || !data) { console.error("saveTrackVersion:", error); return null; }
  return {
    id: data.id,
    trackUri: data.track_uri,
    label: data.label,
    trimStartMs: data.trim_start_ms,
    trimEndMs: data.trim_end_ms,
    skipRegions: data.skip_regions ?? [],
    fadeInMs: data.fade_in_ms,
    fadeOutMs: data.fade_out_ms,
  };
}

export async function deleteTrackVersion(versionId: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("track_versions").delete().eq("id", versionId);
  return !error;
}

// ── Snapshot functions (unchanged) ──

export async function createSnapshot(spotifyToken: string, name?: string) {
  const res = await fetch(`${getSupabaseFunctionsUrl()}/snapshot-library`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spotifyToken, name: name ?? "" }),
  });
  if (!res.ok) throw new Error(`Snapshot failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ snapshotId: string; playlistCount: number; trackCount: number }>;
}

export async function restoreSnapshot(spotifyToken: string, snapshotId: string) {
  const res = await fetch(`${getSupabaseFunctionsUrl()}/restore-snapshot`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spotifyToken, snapshotId }),
  });
  if (!res.ok) throw new Error(`Restore failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ restored: string[]; total: number }>;
}

export async function fetchSnapshots(userId: string): Promise<LibrarySnapshot[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("library_snapshots")
    .select("id, name, playlist_count, track_count, liked_count, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false });
  return (data ?? []).map((s) => ({
    id: s.id, name: s.name, playlistCount: s.playlist_count,
    trackCount: s.track_count, likedCount: s.liked_count ?? 0,
    createdAt: s.created_at,
  }));
}

// ── Liked songs: client-side capture + restore ──

export async function fetchSnapshotLikedTracks(snapshotId: string): Promise<SnapshotLikedTrack[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("snapshot_liked_tracks")
    .select("spotify_track_uri, track_name, artist_name, album_name, album_art_url, duration_ms, added_at, position")
    .eq("snapshot_id", snapshotId).order("position");
  return (data ?? []).map((t) => ({
    spotifyTrackUri: t.spotify_track_uri, trackName: t.track_name,
    artistName: t.artist_name, albumName: t.album_name,
    albumArtUrl: t.album_art_url, durationMs: t.duration_ms,
    addedAt: t.added_at, position: t.position,
  }));
}

type LikedCaptureInput = {
  items: {
    uri: string;
    name: string;
    artists: string;
    albumName: string | null;
    albumArtUrl: string | null;
    durationMs: number;
    addedAt: string;
  }[];
};

/** Insert liked tracks for a snapshot in batches; updates library_snapshots.liked_count. */
export async function storeLikedSongs(
  snapshotId: string,
  input: LikedCaptureInput,
): Promise<void> {
  if (!supabase) throw new Error("Supabase not configured");
  const rows = input.items.map((t, i) => ({
    snapshot_id: snapshotId,
    spotify_track_uri: t.uri,
    track_name: t.name,
    artist_name: t.artists,
    album_name: t.albumName,
    album_art_url: t.albumArtUrl,
    duration_ms: t.durationMs,
    added_at: t.addedAt || null,
    position: i,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from("snapshot_liked_tracks").insert(batch);
    if (error) throw new Error(`Insert liked tracks: ${error.message}`);
  }
  const { error: e2 } = await supabase
    .from("library_snapshots")
    .update({ liked_count: rows.length })
    .eq("id", snapshotId);
  if (e2) throw new Error(`Update liked_count: ${e2.message}`);
}

export async function fetchSnapshotPlaylists(snapshotId: string): Promise<SnapshotPlaylist[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("snapshot_playlists")
    .select("id, spotify_playlist_id, name, description, image_url, owner_name, track_count")
    .eq("snapshot_id", snapshotId);
  return (data ?? []).map((p) => ({
    id: p.id, spotifyPlaylistId: p.spotify_playlist_id, name: p.name,
    description: p.description, imageUrl: p.image_url,
    ownerName: p.owner_name, trackCount: p.track_count,
  }));
}

export async function fetchSnapshotTracks(snapshotPlaylistId: string): Promise<SnapshotTrack[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("snapshot_tracks")
    .select("spotify_track_uri, track_name, artist_name, album_name, album_art_url, duration_ms, position")
    .eq("snapshot_playlist_id", snapshotPlaylistId).order("position");
  return (data ?? []).map((t) => ({
    spotifyTrackUri: t.spotify_track_uri, trackName: t.track_name,
    artistName: t.artist_name, albumName: t.album_name,
    albumArtUrl: t.album_art_url, durationMs: t.duration_ms, position: t.position,
  }));
}

export async function updateSnapshotName(snapshotId: string, name: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("library_snapshots").update({ name }).eq("id", snapshotId);
  return !error;
}

export async function deleteSnapshot(snapshotId: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("library_snapshots").delete().eq("id", snapshotId);
  return !error;
}
