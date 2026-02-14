import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Mixtape, MixtapeNote, MixtapeSummary, MixtapeTrack, SkipRegion, TrackVersion,
} from "../supabase/api";
import {
  fetchUserMixtapes, fetchMixtapeById, saveMixtape, deleteMixtape,
  fetchTrackVersions, saveTrackVersion, deleteTrackVersion,
} from "../supabase/api";
import {
  searchAndCache, hydrateTracks, getAudioFeaturesCached,
  type CachedTrack, type CachedAudioFeatures,
} from "../supabase/cache";
import { uploadMixtapeImage } from "../supabase/storage";
import { formatDuration } from "../spotify/api";
import { ColorPicker } from "../components/ColorPicker";
import { MixtapeCard } from "../components/MixtapeCard";
import { ConfirmModal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { TimelineEditor, type EditState } from "../mixtape/TimelineEditor";
import { resolveEdit } from "../mixtape/edits";

type View = "list" | "edit";

type EditorTrack = {
  trackUri: string;
  position: number;
  versionId: string | null;
  edit: EditState;              // always concrete (trimEndMs defaults to duration)
};

type Props = {
  getToken: () => Promise<string | null>;
  userId: string;
  onPlay: (data: {
    mixtape: Mixtape;
    trackCache: Map<string, CachedTrack>;
    audioFeatures: Map<string, CachedAudioFeatures>;
    versions: Map<string, TrackVersion>;
  }) => void;
};

function toEditorTracks(mixtape: Mixtape, cache: Map<string, CachedTrack>, versions: Map<string, TrackVersion>): EditorTrack[] {
  return mixtape.tracks.map((mt) => {
    const cached = cache.get(mt.trackUri);
    const v = mt.versionId ? versions.get(mt.versionId) ?? null : null;
    const duration = cached?.durationMs ?? 180000;
    const resolved = resolveEdit(mt, v, duration);
    return {
      trackUri: mt.trackUri,
      position: mt.position,
      versionId: mt.versionId,
      edit: {
        skipRegions: resolved.skipRegions,
        fadeInMs: resolved.fadeInMs,
        fadeOutMs: resolved.fadeOutMs,
      },
    };
  });
}

export function LovifyPage({ getToken, userId, onPlay }: Props) {
  const { toast } = useToast();
  const [view, setView] = useState<View>("list");

  // List
  const [mixtapes, setMixtapes] = useState<MixtapeSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Editor meta
  const [mixtapeId, setMixtapeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [theme, setTheme] = useState("rose");
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(null);

  // Editor body
  const [editorTracks, setEditorTracks] = useState<EditorTrack[]>([]);
  const [notes, setNotes] = useState<MixtapeNote[]>([]);
  const [trackCache, setTrackCache] = useState<Map<string, CachedTrack>>(new Map());
  const [focusedUri, setFocusedUri] = useState<string | null>(null);
  const [versionsByTrack, setVersionsByTrack] = useState<Map<string, TrackVersion[]>>(new Map());
  const [versionsById, setVersionsById] = useState<Map<string, TrackVersion>>(new Map());

  // Search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CachedTrack[]>([]);
  const [searching, setSearching] = useState(false);

  // Save UI
  const [saving, setSaving] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const loadMixtapes = useCallback(async () => {
    setLoadingList(true);
    try { setMixtapes(await fetchUserMixtapes(userId)); } catch { /* ignore */ }
    setLoadingList(false);
  }, [userId]);

  useEffect(() => { void loadMixtapes(); }, [loadMixtapes]);

  // ── Debounced search ──
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const r = await searchAndCache(token, query);
        if (!cancelled) setResults(r);
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "Search failed";
          toast(msg, "error");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, getToken, toast]);

  // ── Reset editor state ──
  const resetEditor = () => {
    setMixtapeId(null); setName(""); setMessage(""); setRecipientName("");
    setTheme("rose"); setCoverImageUrl(null);
    setEditorTracks([]); setNotes([]); setTrackCache(new Map());
    setFocusedUri(null); setVersionsByTrack(new Map()); setVersionsById(new Map());
    setQuery(""); setResults([]);
  };

  // ── Open editor (new or existing) ──
  const openNew = () => { resetEditor(); setView("edit"); };

  const openExisting = async (id: string) => {
    const m = await fetchMixtapeById(id);
    if (!m) { toast("Could not load mixtape", "error"); return; }

    const uris = m.tracks.map((t) => t.trackUri);
    const cache = await hydrateTracks(getToken, uris);

    // Load all versions referenced
    const vIds = m.tracks.map((t) => t.versionId).filter((v): v is string => !!v);
    const vMap = new Map<string, TrackVersion>();
    if (vIds.length) {
      // Naive: load per-track versions for each referenced URI
      const uniqueUris = [...new Set(uris)];
      for (const uri of uniqueUris) {
        const list = await fetchTrackVersions(userId, uri);
        for (const v of list) vMap.set(v.id, v);
      }
    }

    setMixtapeId(m.id);
    setName(m.name); setMessage(m.message); setRecipientName(m.recipientName ?? "");
    setTheme(m.theme); setCoverImageUrl(m.coverImageUrl);
    setTrackCache(cache);
    setEditorTracks(toEditorTracks(m, cache, vMap));
    setNotes(m.notes);
    setVersionsById(vMap);
    setFocusedUri(m.tracks[0]?.trackUri ?? null);

    setView("edit");
  };

  // ── Load versions for focused track on change ──
  useEffect(() => {
    if (!focusedUri) return;
    if (versionsByTrack.has(focusedUri)) return;
    void fetchTrackVersions(userId, focusedUri).then((list) => {
      setVersionsByTrack((prev) => {
        const next = new Map(prev);
        next.set(focusedUri, list);
        return next;
      });
      setVersionsById((prev) => {
        const next = new Map(prev);
        for (const v of list) next.set(v.id, v);
        return next;
      });
    });
  }, [focusedUri, userId, versionsByTrack]);

  // ── Add track from search ──
  const addTrack = (t: CachedTrack) => {
    if (editorTracks.some((et) => et.trackUri === t.uri)) return;
    setTrackCache((prev) => {
      const next = new Map(prev);
      next.set(t.uri, t);
      return next;
    });
    const newTrack: EditorTrack = {
      trackUri: t.uri,
      position: editorTracks.length,
      versionId: null,
      edit: { skipRegions: [], fadeInMs: 0, fadeOutMs: 0 },
    };
    setEditorTracks((prev) => [...prev, newTrack]);
    if (!focusedUri) setFocusedUri(t.uri);
  };

  const removeTrack = (uri: string) => {
    setEditorTracks((prev) => prev.filter((et) => et.trackUri !== uri).map((et, i) => ({ ...et, position: i })));
    setNotes((prev) => prev.filter((n) => n.trackUri !== uri));
    if (focusedUri === uri) setFocusedUri(null);
  };

  const moveTrack = (from: number, to: number) => {
    setEditorTracks((prev) => {
      const arr = [...prev];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      return arr.map((et, i) => ({ ...et, position: i }));
    });
  };

  const focused = useMemo(
    () => editorTracks.find((et) => et.trackUri === focusedUri) ?? null,
    [editorTracks, focusedUri],
  );
  const focusedCached = focusedUri ? trackCache.get(focusedUri) : null;

  const updateFocusedEdit = (patch: EditState) => {
    if (!focusedUri) return;
    setEditorTracks((prev) => prev.map((et) =>
      et.trackUri === focusedUri ? { ...et, edit: patch, versionId: null /* inline edit breaks version link */ } : et,
    ));
  };

  const focusedNotes = useMemo(
    () => focusedUri ? notes.filter((n) => n.trackUri === focusedUri) : [],
    [notes, focusedUri],
  );

  const setFocusedNotes = (next: MixtapeNote[]) => {
    if (!focusedUri) return;
    setNotes((prev) => [...prev.filter((n) => n.trackUri !== focusedUri), ...next]);
  };

  const applyVersion = async (versionId: string | null) => {
    if (!focusedUri) return;
    const v = versionId ? versionsById.get(versionId) ?? null : null;
    const duration = focusedCached?.durationMs ?? 180000;
    setEditorTracks((prev) => prev.map((et) => {
      if (et.trackUri !== focusedUri) return et;
      if (!v) return { ...et, versionId: null };
      // Fold legacy trim fields from saved version into skip regions.
      const resolved = resolveEdit(
        { trimStartMs: v.trimStartMs, trimEndMs: v.trimEndMs, skipRegions: v.skipRegions, fadeInMs: v.fadeInMs, fadeOutMs: v.fadeOutMs },
        null, duration,
      );
      return {
        ...et, versionId: v.id,
        edit: { skipRegions: resolved.skipRegions, fadeInMs: resolved.fadeInMs, fadeOutMs: resolved.fadeOutMs },
      };
    }));
  };

  const saveAsVersion = async () => {
    if (!focused || !focusedUri) return;
    const label = window.prompt("Name this version:", "Custom");
    if (!label?.trim()) return;
    const saved = await saveTrackVersion(userId, {
      trackUri: focusedUri, label: label.trim(),
      trimStartMs: 0,
      trimEndMs: null,
      skipRegions: focused.edit.skipRegions,
      fadeInMs: focused.edit.fadeInMs,
      fadeOutMs: focused.edit.fadeOutMs,
    });
    if (!saved) { toast("Save version failed", "error"); return; }
    setVersionsById((prev) => new Map(prev).set(saved.id, saved));
    setVersionsByTrack((prev) => {
      const next = new Map(prev);
      const list = next.get(focusedUri) ?? [];
      next.set(focusedUri, [saved, ...list]);
      return next;
    });
    setEditorTracks((prev) => prev.map((et) =>
      et.trackUri === focusedUri ? { ...et, versionId: saved.id } : et,
    ));
    toast(`Saved "${saved.label}"`);
  };

  const removeVersion = async (id: string) => {
    if (!focusedUri) return;
    const ok = await deleteTrackVersion(id);
    if (!ok) { toast("Delete failed", "error"); return; }
    setVersionsById((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setVersionsByTrack((prev) => {
      const next = new Map(prev);
      const list = (next.get(focusedUri) ?? []).filter((v) => v.id !== id);
      next.set(focusedUri, list);
      return next;
    });
    setEditorTracks((prev) => prev.map((et) =>
      et.versionId === id ? { ...et, versionId: null } : et,
    ));
  };

  // ── Save mixtape ──
  const handleSave = async () => {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (!editorTracks.length) { toast("Add at least one track", "error"); return; }

    setSaving(true);
    try {
      const mixtapeTracks: Omit<MixtapeTrack, "id">[] = editorTracks.map((et) => ({
        position: et.position,
        trackUri: et.trackUri,
        versionId: et.versionId,
        trimStartMs: null,
        trimEndMs: null,
        skipRegions: et.versionId ? null : et.edit.skipRegions,
        fadeInMs: et.versionId ? null : et.edit.fadeInMs,
        fadeOutMs: et.versionId ? null : et.edit.fadeOutMs,
      }));

      const sanitizedNotes: Omit<MixtapeNote, "id">[] = notes
        .filter((n) => editorTracks.some((et) => et.trackUri === n.trackUri))
        .map((n) => ({
          trackUri: n.trackUri,
          timestampMs: n.timestampMs,
          durationMs: n.durationMs,
          text: n.text,
          color: n.color,
          emoji: n.emoji,
          imageUrl: n.imageUrl,
          visualType: n.visualType,
        }));

      const result = await saveMixtape({
        id: mixtapeId ?? undefined,
        userId,
        name: name.trim(),
        theme, message,
        recipientName: recipientName || null,
        coverImageUrl, backgroundImageUrl: null,
        tracks: mixtapeTracks,
        notes: sanitizedNotes,
        images: [],
      });

      if (!result) { toast("Save failed", "error"); return; }
      toast("Saved");
      resetEditor();
      setView("list");
      await loadMixtapes();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    if (await deleteMixtape(id)) {
      setMixtapes((prev) => prev.filter((m) => m.id !== id));
      toast("Deleted");
    }
  };

  const handleShare = (token: string) => {
    const url = `${window.location.origin}/mix/${token}`;
    navigator.clipboard.writeText(url)
      .then(() => toast("Share link copied"))
      .catch(() => toast(url, "info"));
  };

  const handlePlay = async (id: string) => {
    const m = await fetchMixtapeById(id);
    if (!m) { toast("Could not load mixtape", "error"); return; }

    const uris = m.tracks.map((t) => t.trackUri);
    const cache = await hydrateTracks(getToken, uris);
    const af = await getAudioFeaturesCached(getToken, uris);

    // Hydrate version refs
    const vMap = new Map<string, TrackVersion>();
    const uniqueUris = [...new Set(uris)];
    for (const uri of uniqueUris) {
      const list = await fetchTrackVersions(userId, uri);
      for (const v of list) vMap.set(v.id, v);
    }

    onPlay({ mixtape: m, trackCache: cache, audioFeatures: af, versions: vMap });
  };

  // ═══════════════════════════════════════════════════════════
  //  LIST VIEW
  // ═══════════════════════════════════════════════════════════
  if (view === "list") {
    return (
      <>
        <div className="page-header">
          <div className="row-between">
            <div>
              <h1 className="page-title">Mixtapes</h1>
              <p className="page-subtitle">playlists with love notes, trims, and pictures</p>
            </div>
            <button className="btn btn-primary" onClick={openNew}>+ New Mixtape</button>
          </div>
        </div>

        {loadingList ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 200, borderRadius: 16 }} />)}
          </div>
        ) : mixtapes.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">♡</span>
            <p>Create your first mixtape — trim tracks, pin notes with pictures, and share a link.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {mixtapes.map((m) => (
              <MixtapeCard
                key={m.id} mixtape={m}
                onEdit={() => openExisting(m.id)}
                onDelete={() => setConfirmDeleteId(m.id)}
                onShare={() => handleShare(m.shareToken)}
                onPlay={() => handlePlay(m.id)}
              />
            ))}
          </div>
        )}
        <ConfirmModal
          open={confirmDeleteId !== null}
          title="Delete Mixtape"
          message="This will permanently delete this mixtape."
          confirmLabel="Delete" danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />
      </>
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  EDITOR VIEW
  // ═══════════════════════════════════════════════════════════
  const totalNotes = notes.length;
  const totalSkips = editorTracks.reduce((s, et) => s + et.edit.skipRegions.length, 0);
  const focusedVersions = focusedUri ? versionsByTrack.get(focusedUri) ?? [] : [];

  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => { if (confirm("Discard edits?")) { resetEditor(); setView("list"); } }}
        style={{ marginBottom: 12 }}
      >← Back</button>

      <CoverHeader
        name={name} setName={setName}
        recipientName={recipientName} setRecipientName={setRecipientName}
        theme={theme} setTheme={setTheme}
        coverImageUrl={coverImageUrl} setCoverImageUrl={setCoverImageUrl}
        mixtapeId={mixtapeId}
      />

      <details style={{ marginBottom: 20 }}>
        <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--text-secondary)", padding: "4px 0" }}>
          + Add a message {message ? `(${message.length} chars)` : ""}
        </summary>
        <textarea
          className="input" placeholder="A dedication, a line from a song, a memory..."
          value={message} onChange={(e) => setMessage(e.target.value)}
          style={{ minHeight: 60, resize: "vertical", borderRadius: 12, marginTop: 6 }}
        />
      </details>

      {/* Search + selected tracks */}
      <div style={{ maxWidth: 820 }}>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <input
            className="input" placeholder="Search Spotify for a track..."
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <span style={{
            position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
            fontSize: "0.72rem", color: "var(--text-muted)",
          }}>...</span>}
        </div>

        {results.length > 0 && (
          <div style={{
            maxHeight: 240, overflowY: "auto", borderRadius: 12,
            border: "1px solid var(--border)", marginBottom: 16,
          }}>
            {results.map((t) => {
              const added = editorTracks.some((et) => et.trackUri === t.uri);
              return (
                <CachedTrackRow
                  key={t.uri} track={t}
                  action={added ? <span style={{ fontSize: "0.72rem", color: "var(--emerald)" }}>✓</span>
                    : <button className="btn btn-ghost btn-sm" onClick={() => addTrack(t)}>+ add</button>}
                />
              );
            })}
          </div>
        )}

        {editorTracks.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 6 }}>
              Click a track to edit. Drag to reorder.
            </div>
            {editorTracks.map((et, i) => {
              const cached = trackCache.get(et.trackUri);
              const isFocused = et.trackUri === focusedUri;
              const noteCount = notes.filter((n) => n.trackUri === et.trackUri).length;
              const skipCount = et.edit.skipRegions.length;

              return (
                <div key={et.trackUri}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragIdx !== null && dragIdx !== i) moveTrack(dragIdx, i); setDragIdx(null); }}
                  onDragEnd={() => setDragIdx(null)}
                  style={{
                    marginBottom: 4, opacity: dragIdx === i ? 0.5 : 1,
                    border: isFocused ? "1px solid var(--rose)" : "1px solid transparent",
                    borderRadius: 10,
                  }}
                >
                  <div
                    onClick={() => setFocusedUri(isFocused ? null : et.trackUri)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 10px", cursor: "pointer",
                      background: isFocused ? "var(--rose-dim)" : "transparent",
                      borderRadius: 10,
                    }}
                  >
                    <span style={{ width: 20, textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>{i + 1}</span>
                    {cached?.albumArtUrl
                      ? <img src={cached.albumArtUrl} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover" }} />
                      : <div style={{ width: 40, height: 40, borderRadius: 6, background: "var(--surface)" }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.88rem", fontWeight: 500, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
                        {cached?.name ?? "Loading..."}
                      </div>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-muted)", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
                        {cached?.artists ?? ""}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 4 }}>
                      {skipCount > 0 && <span className="badge">{skipCount}·skip</span>}
                      {noteCount > 0 && <span className="badge badge-rose">{noteCount}·note</span>}
                      {et.versionId && <span className="badge" title="saved version">v</span>}
                    </div>

                    <span style={{ fontSize: "0.74rem", color: "var(--text-muted)", minWidth: 40, textAlign: "right" }}>
                      {cached ? formatDuration(cached.durationMs) : ""}
                    </span>
                    <button className="btn btn-ghost btn-xs" style={{ color: "var(--rose)" }}
                      onClick={(e) => { e.stopPropagation(); removeTrack(et.trackUri); }}>×</button>
                  </div>

                  {isFocused && focusedCached && (
                    <div style={{ padding: "0 10px 10px" }}>
                      <TimelineEditor
                        trackUri={et.trackUri}
                        trackDurationMs={focusedCached.durationMs}
                        edit={et.edit}
                        onChange={updateFocusedEdit}
                        notes={focusedNotes}
                        onNotesChange={setFocusedNotes}
                        onUploadImage={(file) => uploadMixtapeImage(file, mixtapeId ?? "pending", "note")}
                      />

                      <VersionsPanel
                        activeVersionId={et.versionId}
                        versions={focusedVersions}
                        onPick={applyVersion}
                        onSaveNew={saveAsVersion}
                        onRemove={removeVersion}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky save bar */}
      <div style={{
        position: "sticky", bottom: 56,
        padding: "12px 16px", marginTop: 24,
        background: "rgba(10,10,10,0.92)", backdropFilter: "blur(12px)",
        borderRadius: 16, border: "1px solid var(--border)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {editorTracks.length} tracks · {totalNotes} notes · {totalSkips} skips
          <span style={{ color: `var(--${theme})`, marginLeft: 8 }}>{theme}</span>
        </div>
        <button className="btn btn-primary" onClick={handleSave}
          disabled={saving || !name.trim() || !editorTracks.length}
          style={{ minWidth: 140 }}>
          {saving ? "Saving..." : mixtapeId ? "Save Changes" : "Save Mixtape"}
        </button>
      </div>
    </>
  );
}

// ── Cover header (inline) ──

function CoverHeader({
  name, setName, recipientName, setRecipientName,
  theme, setTheme, coverImageUrl, setCoverImageUrl, mixtapeId,
}: {
  name: string; setName: (s: string) => void;
  recipientName: string; setRecipientName: (s: string) => void;
  theme: string; setTheme: (s: string) => void;
  coverImageUrl: string | null; setCoverImageUrl: (s: string | null) => void;
  mixtapeId: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        onClick={() => fileRef.current?.click()}
        style={{
          position: "relative", borderRadius: 20, overflow: "hidden",
          height: 200, cursor: "pointer",
          background: coverImageUrl ? `url(${coverImageUrl}) center/cover`
            : `linear-gradient(135deg, var(--${theme}) 0%, var(--bg) 100%)`,
        }}
      >
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(transparent 20%, rgba(0,0,0,0.7) 100%)",
          display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 24,
        }}>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Name your mixtape..."
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "transparent", border: "none", outline: "none",
              fontFamily: "'Playfair Display', serif", fontSize: "1.6rem", fontWeight: 700,
              color: "#fff", width: "100%", letterSpacing: "-0.02em",
            }} />
          <input
            value={recipientName} onChange={(e) => setRecipientName(e.target.value)}
            placeholder="for..."
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "transparent", border: "none", outline: "none",
              fontSize: "0.88rem", color: "rgba(255,255,255,0.6)", width: "100%", marginTop: 4,
            }} />
        </div>
        <div style={{ position: "absolute", top: 12, right: 12 }} onClick={(e) => e.stopPropagation()}>
          <ColorPicker selected={theme} onChange={setTheme} includeSlate />
        </div>
        {!coverImageUrl && (
          <div style={{ position: "absolute", top: 12, left: 12, fontSize: "0.72rem", color: "rgba(255,255,255,0.4)" }}>
            tap to add cover
          </div>
        )}
        <input
          ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const url = await uploadMixtapeImage(file, mixtapeId ?? "pending", "cover");
            if (url) setCoverImageUrl(url);
            e.target.value = "";
          }}
        />
      </div>
      {coverImageUrl && (
        <button className="btn btn-ghost btn-xs"
          onClick={() => setCoverImageUrl(null)}
          style={{ marginTop: 6, fontSize: "0.72rem" }}>
          Remove cover
        </button>
      )}
    </div>
  );
}

// ── Versions panel (inline) ──

function VersionsPanel({
  activeVersionId, versions, onPick, onSaveNew, onRemove,
}: {
  activeVersionId: string | null;
  versions: TrackVersion[];
  onPick: (id: string | null) => void;
  onSaveNew: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>versions:</span>
      <button
        className={`btn btn-ghost btn-xs ${activeVersionId === null ? "active" : ""}`}
        onClick={() => onPick(null)}
        style={{
          fontSize: "0.72rem",
          ...(activeVersionId === null ? { background: "var(--rose-dim)", color: "var(--rose)" } : {}),
        }}
      >
        custom
      </button>
      {versions.map((v) => (
        <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => onPick(v.id)}
            style={{
              fontSize: "0.72rem",
              ...(activeVersionId === v.id ? { background: "var(--rose-dim)", color: "var(--rose)" } : {}),
            }}
          >
            {v.label}
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => { if (confirm(`Delete version "${v.label}"?`)) onRemove(v.id); }}
            style={{ fontSize: "0.65rem", color: "var(--text-muted)", padding: "0 4px" }}
          >×</button>
        </span>
      ))}
      <button
        className="btn btn-ghost btn-xs"
        onClick={onSaveNew}
        style={{ fontSize: "0.72rem", marginLeft: 4 }}
      >
        + save as…
      </button>
    </div>
  );
}

// ── Cached track row (used in search results) ──

function CachedTrackRow({ track, action }: { track: CachedTrack; action?: React.ReactNode }) {
  return (
    <div className="track-row" style={{ padding: "8px 12px" }}>
      {track.albumArtUrl
        ? <img className="track-art" src={track.albumArtUrl} alt="" style={{ width: 36, height: 36 }} />
        : <div className="track-art-placeholder" style={{ width: 36, height: 36 }}>♫</div>}
      <div className="track-info">
        <span className="track-name">{track.name}</span>
        <span className="track-artist">{track.artists}</span>
      </div>
      <span className="track-duration">{formatDuration(track.durationMs)}</span>
      {action && <div className="track-actions">{action}</div>}
    </div>
  );
}
