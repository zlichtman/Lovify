import { useState, useEffect, useRef } from "react";
import {
  fetchSnapshots, createSnapshot, deleteSnapshot, restoreSnapshot,
  fetchSnapshotPlaylists, fetchSnapshotTracks, updateSnapshotName,
  fetchSnapshotLikedTracks, storeLikedSongs,
  type LibrarySnapshot, type SnapshotPlaylist, type SnapshotTrack, type SnapshotLikedTrack,
} from "../supabase/api";
import {
  formatDuration, createPlaylist, addTracksToPlaylist, fetchMe,
  fetchAllSavedTracks, saveLikedTracks,
  type SpotifyPlaylist,
} from "../spotify/api";
import { ConfirmModal } from "../components/Modal";
import { useToast } from "../components/Toast";

type Props = { getToken: () => Promise<string | null>; userId: string };

function escapeCsv(s: string | null | undefined): string {
  if (!s) return "";
  if (s.includes('"') || s.includes(",") || s.includes("\n"))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function defaultName(): string {
  return `Library Backup \u2014 ${formatDate(new Date().toISOString())}`;
}

// Client-side CSV parser
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { result.push(current); current = ""; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(raw: string): Record<string, string>[] {
  let csv = raw;
  if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1);
  csv = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = csv.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

export function Backupify({ getToken, userId }: Props) {
  const { toast } = useToast();
  const [snapshots, setSnapshots] = useState<LibrarySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<SnapshotPlaylist[]>([]);
  const [expandedPlaylist, setExpandedPlaylist] = useState<string | null>(null);
  const [tracks, setTracks] = useState<SnapshotTrack[]>([]);
  const [likedExpanded, setLikedExpanded] = useState(false);
  const [likedTracks, setLikedTracks] = useState<SnapshotLikedTrack[]>([]);
  const [captureProgress, setCaptureProgress] = useState("");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showNameInput, setShowNameInput] = useState(false);
  const [captureName, setCaptureName] = useState(defaultName());
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try { setSnapshots(await fetchSnapshots(userId)); } catch { }
    setLoading(false);
  };

  useEffect(() => { reload(); }, [userId]);
  useEffect(() => { if (showNameInput) setTimeout(() => nameInputRef.current?.select(), 50); }, [showNameInput]);

  const handleCreate = async () => {
    if (!captureName.trim()) return;
    setShowNameInput(false);
    setCapturing(true);
    setCaptureProgress("Capturing playlists...");
    try {
      const token = await getToken();
      if (!token) throw new Error("Not logged in");
      const result = await createSnapshot(token, captureName.trim());
      console.log("[Backup] snapshot created:", result);
      if (!result?.snapshotId) throw new Error("Edge function did not return snapshotId");

      // Liked songs: isolated try/catch so a failure here doesn't lose the snapshot.
      let likedCount = 0;
      try {
        setCaptureProgress("Fetching liked songs...");
        const likeToken = (await getToken()) ?? token;
        const saved = await fetchAllSavedTracks(likeToken, (fetched, total) => {
          setCaptureProgress(`Fetching liked songs... ${fetched}/${total}`);
        });
        console.log(`[Backup] fetched ${saved.length} liked songs`);
        if (saved.length > 0) {
          setCaptureProgress(`Saving ${saved.length} liked songs...`);
          await storeLikedSongs(result.snapshotId, {
            items: saved.map((s) => ({
              uri: s.track.uri,
              name: s.track.name,
              artists: (s.track.artists ?? []).map((a) => a.name).join(", "),
              albumName: s.track.album?.name ?? null,
              albumArtUrl: s.track.album?.images?.[0]?.url ?? null,
              durationMs: s.track.duration_ms ?? 0,
              addedAt: s.added_at,
            })),
          });
          likedCount = saved.length;
          console.log(`[Backup] stored ${likedCount} liked songs for ${result.snapshotId}`);
        }
      } catch (likeErr: any) {
        console.error("[Backup] liked songs step failed:", likeErr);
        const lmsg = likeErr?.message ?? "unknown";
        toast(`Liked songs failed: ${lmsg}`, "error");
      }

      toast(`Captured ${result.playlistCount} playlists, ${result.trackCount} tracks, ${likedCount} liked`);
      setCaptureName(defaultName());
      await reload();
    } catch (e: any) {
      const msg = e?.message ?? "Capture failed";
      if (msg.includes("429") || msg.includes("rate limit")) {
        toast("Spotify rate limit hit — wait a minute and try again", "error");
      } else {
        toast(msg, "error");
      }
    }
    setCapturing(false);
    setCaptureProgress("");
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const id = confirmDelete;
    setConfirmDelete(null);
    await deleteSnapshot(id);
    setSnapshots((s) => s.filter((x) => x.id !== id));
    if (expandedId === id) setExpandedId(null);
    toast("Snapshot deleted");
  };

  const handleRestore = async () => {
    if (!confirmRestore) return;
    const id = confirmRestore;
    setConfirmRestore(null);
    setRestoring(id);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not logged in");
      const result = await restoreSnapshot(token, id);

      // Restore liked songs separately (PUT /me/tracks).
      const liked = await fetchSnapshotLikedTracks(id);
      let likedRestored = 0;
      if (liked.length > 0) {
        const t2 = (await getToken()) ?? token;
        const ids = liked
          .map((t) => t.spotifyTrackUri.replace(/^spotify:track:/, ""))
          .filter((x) => x && !x.includes(":"));
        likedRestored = await saveLikedTracks(t2, ids);
      }

      const parts = [`${result.total} playlists`];
      if (likedRestored > 0) parts.push(`${likedRestored} liked songs`);
      toast(`Restored ${parts.join(" + ")} to your Spotify`);
    } catch (e: any) {
      const msg = e?.message ?? "Restore failed";
      if (msg.includes("403")) {
        toast("This account isn't authorized to create playlists. Add it in the Spotify Developer Dashboard under User Management.", "error");
      } else {
        toast(msg, "error");
      }
    }
    setRestoring(null);
  };

  const handleExport = async (snapshotId: string, snapshotName: string) => {
    setExporting(snapshotId);
    try {
      const pls = await fetchSnapshotPlaylists(snapshotId);
      const rows: string[] = [];
      rows.push("playlist_name,playlist_description,owner,track_name,artist_name,album_name,spotify_uri,duration_ms,position");
      for (const pl of pls) {
        const trks = await fetchSnapshotTracks(pl.id);
        for (const t of trks) {
          rows.push([
            escapeCsv(pl.name), escapeCsv(pl.description), escapeCsv(pl.ownerName),
            escapeCsv(t.trackName), escapeCsv(t.artistName), escapeCsv(t.albumName),
            t.spotifyTrackUri, String(t.durationMs ?? 0), String(t.position),
          ].join(","));
        }
      }
      // Liked songs use a sentinel playlist name so import can re-save to /me/tracks.
      const liked = await fetchSnapshotLikedTracks(snapshotId);
      for (const t of liked) {
        rows.push([
          escapeCsv("__liked_songs__"), "", "",
          escapeCsv(t.trackName), escapeCsv(t.artistName), escapeCsv(t.albumName),
          t.spotifyTrackUri, String(t.durationMs ?? 0), String(t.position),
        ].join(","));
      }
      const csv = rows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lovify-backup-${snapshotName || "snapshot"}.csv`.replace(/[^a-zA-Z0-9._\u2014 -]/g, "_");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("CSV downloaded");
    } catch (e: any) { toast(e?.message ?? "Export failed", "error"); }
    setExporting(null);
  };

  // ── CLIENT-SIDE CSV IMPORT ──
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportProgress("Reading file...");
    try {
      const raw = await file.text();
      const rows = parseCsv(raw);

      if (rows.length === 0) {
        throw new Error("No data rows found in CSV");
      }

      // Find the right column names (flexible matching)
      const firstRow = rows[0];
      const keys = Object.keys(firstRow);
      const findCol = (candidates: string[]) =>
        keys.find((k) => candidates.some((c) => k.toLowerCase().includes(c))) ?? "";

      const playlistNameCol = findCol(["playlist_name", "playlist"]);
      const descCol = findCol(["description", "playlist_desc"]);
      const trackNameCol = findCol(["track_name", "track", "song"]);
      const artistCol = findCol(["artist_name", "artist"]);
      const uriCol = findCol(["spotify_uri", "uri", "track_uri"]);

      if (!playlistNameCol) {
        throw new Error(`Can't find playlist name column. Found columns: ${keys.join(", ")}`);
      }
      if (!uriCol) {
        throw new Error(`Can't find spotify URI column. Found columns: ${keys.join(", ")}`);
      }

      // Group by playlist; liked songs get routed separately via sentinel name.
      const LIKED_SENTINEL = "__liked_songs__";
      const playlistMap = new Map<string, { description: string; uris: string[] }>();
      const likedUris: string[] = [];
      let emptyUriCount = 0;
      let invalidUriCount = 0;
      for (const row of rows) {
        const name = row[playlistNameCol];
        if (!name) continue;
        const uri = row[uriCol];
        const isLiked = name === LIKED_SENTINEL;
        if (!uri || uri.trim() === "") { emptyUriCount++; continue; }
        if (!uri.startsWith("spotify:")) { invalidUriCount++; console.warn("Import: invalid URI:", uri); continue; }
        if (isLiked) { likedUris.push(uri.trim()); continue; }
        if (!playlistMap.has(name)) {
          playlistMap.set(name, { description: descCol ? (row[descCol] || "") : "", uris: [] });
        }
        playlistMap.get(name)!.uris.push(uri.trim());
      }

      // Log parsing results
      let totalParsedTracks = 0;
      for (const [name, { uris }] of playlistMap) {
        console.log(`Import: playlist "${name}" — ${uris.length} tracks`);
        totalParsedTracks += uris.length;
      }
      console.log(`Import: ${playlistMap.size} playlists, ${totalParsedTracks} total tracks, ${emptyUriCount} empty URIs, ${invalidUriCount} invalid URIs`);

      if (playlistMap.size === 0 && likedUris.length === 0) {
        throw new Error(`Parsed ${rows.length} rows but found 0 playlists or liked songs. Columns found: ${keys.join(", ")}`);
      }

      if (totalParsedTracks === 0 && likedUris.length === 0 && emptyUriCount > 0) {
        throw new Error(`Found ${playlistMap.size} playlists but all ${emptyUriCount} track URIs are empty. The CSV may have been exported from an incomplete snapshot.`);
      }

      let token = await getToken();
      if (!token) throw new Error("Not logged in");

      // Pre-check: verify token works and show account info
      setImportProgress("Verifying account permissions...");
      const me = await fetchMe(token);
      console.log("Import: logged in as", me.id, me.email, me.display_name);
      setImportProgress(`Importing ${playlistMap.size} playlists (${totalParsedTracks} tracks) as ${me.display_name}...`);

      let created = 0;
      let totalTracks = 0;
      let failures = 0;
      const total = playlistMap.size;
      let idx = 0;

      for (const [name, { description, uris }] of playlistMap) {
        idx++;
        setImportProgress(`Creating playlist ${idx}/${total}: ${name} (${uris.length} tracks)`);
        try {
          // Retry wrapper for rate limits
          let pl: SpotifyPlaylist | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              if (attempt > 0) {
                token = await getToken();
                if (!token) throw new Error("Not logged in");
              }
              pl = await createPlaylist(token!, userId, name, description, false);
              break;
            } catch (retryErr: any) {
              const retryMsg = retryErr?.message ?? "";
              if (retryMsg.includes("429") && attempt < 2) {
                setImportProgress(`Rate limited — waiting before retry... (${name})`);
                await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
                continue;
              }
              throw retryErr;
            }
          }

          if (!pl) throw new Error("Failed to create playlist after retries");
          console.log(`Import: created playlist "${name}" (id: ${pl.id})`);

          if (uris.length > 0) {
            for (let i = 0; i < uris.length; i += 100) {
              const batch = uris.slice(i, i + 100);
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  await addTracksToPlaylist(token!, pl.id, batch);
                  console.log(`Import: added ${batch.length} tracks to "${name}"`);
                  break;
                } catch (retryErr: any) {
                  const retryMsg = retryErr?.message ?? "";
                  console.error(`Import: failed to add tracks to "${name}" (attempt ${attempt + 1}):`, retryMsg);
                  if (retryMsg.includes("429") && attempt < 2) {
                    await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
                    continue;
                  }
                  // Show specific error for track addition vs playlist creation
                  throw new Error(`Playlist "${name}" was created but adding tracks failed: ${retryMsg}`);
                }
              }
            }
            totalTracks += uris.length;
          }
          created++;
        } catch (err: any) {
          failures++;
          const msg = err?.message ?? "unknown error";
          toast(`Failed: ${name} — ${msg}`, "error");
        }
      }

      // Liked songs: PUT /me/tracks in batches of 50.
      let likedSaved = 0;
      if (likedUris.length > 0) {
        setImportProgress(`Saving ${likedUris.length} liked songs...`);
        try {
          const t2 = (await getToken()) ?? token!;
          const ids = likedUris
            .map((u) => u.replace(/^spotify:track:/, ""))
            .filter((x) => x && !x.includes(":"));
          likedSaved = await saveLikedTracks(t2, ids, (s, t) => {
            setImportProgress(`Saving liked songs... ${s}/${t}`);
          });
        } catch (err: any) {
          toast(`Liked songs failed: ${err?.message ?? "unknown"}`, "error");
        }
      }

      const bits: string[] = [];
      if (created > 0) bits.push(`${created} playlists (${totalTracks} tracks)`);
      if (likedSaved > 0) bits.push(`${likedSaved} liked songs`);
      if (bits.length > 0) {
        toast(`Imported ${bits.join(" + ")} to Spotify${failures > 0 ? ` (${failures} failed)` : ""}`);
      } else if (totalParsedTracks === 0 && likedUris.length === 0) {
        toast("Import created playlists but CSV had no track URIs — playlists are empty", "error");
      } else {
        toast("Import failed — nothing was created", "error");
      }
    } catch (e: any) {
      toast(e?.message ?? "Import failed", "error");
    }
    setImporting(false);
    setImportProgress("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const toggleExpand = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    setExpandedPlaylist(null);
    setLikedExpanded(false);
    setLikedTracks([]);
    try {
      const [pls, liked] = await Promise.all([
        fetchSnapshotPlaylists(id),
        fetchSnapshotLikedTracks(id),
      ]);
      setPlaylists(pls);
      setLikedTracks(liked);
    } catch { }
  };

  const togglePlaylist = async (id: string) => {
    if (expandedPlaylist === id) { setExpandedPlaylist(null); return; }
    setExpandedPlaylist(id);
    try { setTracks(await fetchSnapshotTracks(id)); } catch { }
  };

  const startRename = (id: string, currentName: string) => { setEditingNameId(id); setEditNameValue(currentName); };
  const saveRename = async () => {
    if (!editingNameId || !editNameValue.trim()) return;
    const ok = await updateSnapshotName(editingNameId, editNameValue.trim());
    if (ok) {
      setSnapshots((prev) => prev.map((s) => s.id === editingNameId ? { ...s, name: editNameValue.trim() } : s));
    }
    setEditingNameId(null);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Backups</h1>
        <p className="page-subtitle">snapshot and restore your library</p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        {showNameInput ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, maxWidth: 480 }}>
            <input ref={nameInputRef} className="input" value={captureName} onChange={(e) => setCaptureName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowNameInput(false); }} placeholder="Backup name..." style={{ flex: 1 }} />
            <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={!captureName.trim()}>Capture</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowNameInput(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={() => setShowNameInput(true)} disabled={capturing}>
            {capturing ? "Capturing..." : "Capture Snapshot"}
          </button>
        )}
        <label className="btn btn-ghost" style={{ cursor: "pointer" }}>
          {importing ? "Importing..." : "Import CSV"}
          <input ref={fileRef} type="file" accept=".csv" onChange={handleImport} style={{ display: "none" }} disabled={importing} />
        </label>
      </div>

      {(capturing || importing) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginBottom: 6 }}>
            {importing ? importProgress || "Processing..." : captureProgress || "Scanning your library..."}
          </div>
          <div className="progress-bar progress-bar-indeterminate"><div className="progress-bar-fill" /></div>
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => <div key={i} className="skeleton skeleton-card" />)}
        </div>
      ) : snapshots.length === 0 ? (
        <div className="empty">
          <span className="empty-icon">&#9729;</span>
          <p>No snapshots yet. Capture one to back up your library.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {snapshots.map((s) => (
            <div key={s.id} className="card">
              <div className="row-between" style={{ cursor: "pointer" }} onClick={() => toggleExpand(s.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingNameId === s.id ? (
                    <div className="inline-edit" onClick={(e) => e.stopPropagation()}>
                      <input className="inline-edit-input" value={editNameValue} onChange={(e) => setEditNameValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setEditingNameId(null); }} onBlur={saveRename} autoFocus style={{ fontSize: "0.92rem", fontWeight: 600, width: "100%", maxWidth: 300 }} />
                    </div>
                  ) : (
                    <div style={{ fontWeight: 600, cursor: "text" }} onClick={(e) => { e.stopPropagation(); startRename(s.id, s.name || "Unnamed"); }} title="Click to rename">
                      {s.name || "Unnamed"}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                    <span className="badge">{s.playlistCount} playlists</span>
                    <span className="badge">{s.trackCount} tracks</span>
                    {s.likedCount > 0 && <span className="badge">&#9825; {s.likedCount} liked</span>}
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{formatDate(s.createdAt)}</span>
                  </div>
                </div>
                <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleExport(s.id, s.name); }} disabled={exporting === s.id}>{exporting === s.id ? "..." : "Export"}</button>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setConfirmRestore(s.id); }} disabled={restoring === s.id}>{restoring === s.id ? "..." : "Restore"}</button>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setConfirmDelete(s.id); }} style={{ color: "var(--rose)" }}>Delete</button>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginLeft: 4 }}>{expandedId === s.id ? "\u25BE" : "\u25B8"}</span>
                </div>
              </div>
              {expandedId === s.id && (playlists.length > 0 || likedTracks.length > 0) && (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  {likedTracks.length > 0 && (
                    <div>
                      <div className="track-row" onClick={() => setLikedExpanded((v) => !v)} style={{ cursor: "pointer" }}>
                        <div className="track-art-placeholder" style={{ width: 36, height: 36, background: "var(--rose-dim, rgba(232,69,124,0.15))", color: "var(--rose)" }}>&#9825;</div>
                        <div className="track-info">
                          <span className="track-name" style={{ fontSize: "0.82rem" }}>Liked Songs</span>
                          <span className="track-artist">{likedTracks.length} tracks</span>
                        </div>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{likedExpanded ? "\u25BE" : "\u25B8"}</span>
                      </div>
                      {likedExpanded && (
                        <div style={{ paddingLeft: 20 }}>
                          {likedTracks.map((t, i) => (
                            <div key={`liked-${t.spotifyTrackUri}-${i}`} className="track-row" style={{ padding: "4px 8px" }}>
                              <span className="track-rank" style={{ fontSize: "0.7rem" }}>{t.position + 1}</span>
                              <div className="track-info">
                                <span className="track-name" style={{ fontSize: "0.78rem" }}>{t.trackName}</span>
                                <span className="track-artist" style={{ fontSize: "0.7rem" }}>{t.artistName}</span>
                              </div>
                              <span className="track-duration">{formatDuration(t.durationMs)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {playlists.map((pl) => (
                    <div key={pl.id}>
                      <div className="track-row" onClick={() => togglePlaylist(pl.id)} style={{ cursor: "pointer" }}>
                        {pl.imageUrl ? <img className="track-art" src={pl.imageUrl} alt="" style={{ width: 36, height: 36 }} /> : <div className="track-art-placeholder" style={{ width: 36, height: 36 }}>&#9835;</div>}
                        <div className="track-info">
                          <span className="track-name" style={{ fontSize: "0.82rem" }}>{pl.name}</span>
                          <span className="track-artist">{pl.trackCount} tracks</span>
                        </div>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{expandedPlaylist === pl.id ? "\u25BE" : "\u25B8"}</span>
                      </div>
                      {expandedPlaylist === pl.id && (
                        <div style={{ paddingLeft: 20 }}>
                          {tracks.map((t, i) => (
                            <div key={`${t.spotifyTrackUri}-${i}`} className="track-row" style={{ padding: "4px 8px" }}>
                              <span className="track-rank" style={{ fontSize: "0.7rem" }}>{t.position + 1}</span>
                              <div className="track-info">
                                <span className="track-name" style={{ fontSize: "0.78rem" }}>{t.trackName}</span>
                                <span className="track-artist" style={{ fontSize: "0.7rem" }}>{t.artistName}</span>
                              </div>
                              <span className="track-duration">{formatDuration(t.durationMs)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal open={confirmDelete !== null} title="Delete Snapshot" message="This will permanently delete this snapshot and all its data." confirmLabel="Delete" danger onConfirm={handleDelete} onCancel={() => setConfirmDelete(null)} />
      <ConfirmModal open={confirmRestore !== null} title="Restore Snapshot" message="This will recreate all playlists and re-save all Liked Songs from this snapshot to your Spotify account." confirmLabel="Restore" onConfirm={handleRestore} onCancel={() => setConfirmRestore(null)} />
    </>
  );
}
