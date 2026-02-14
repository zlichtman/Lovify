import { useEffect, useMemo, useState } from "react";
import { fetchSharedMixtape, fetchTrackVersions, type Mixtape, type TrackVersion } from "../supabase/api";
import { formatDuration } from "../spotify/api";
import { hydrateTracks, getAudioFeaturesCached, type CachedTrack, type CachedAudioFeatures } from "../supabase/cache";
import { resolveEdit } from "../mixtape/edits";

type Props = {
  shareToken: string;
  onBack: () => void;
  onPlay?: (data: {
    mixtape: Mixtape;
    trackCache: Map<string, CachedTrack>;
    audioFeatures: Map<string, CachedAudioFeatures>;
    versions: Map<string, TrackVersion>;
  }) => void;
};

function fmt(ms: number) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Public share page — no Spotify auth assumed. Shows track list, notes,
 * and a Play button that only works if the viewer is also signed in upstream.
 */
export function MixtapeView({ shareToken, onBack, onPlay }: Props) {
  const [mixtape, setMixtape] = useState<Mixtape | null>(null);
  const [trackCache, setTrackCache] = useState<Map<string, CachedTrack>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const m = await fetchSharedMixtape(shareToken);
        if (!m) { setError("Mixtape not found"); return; }
        setMixtape(m);

        // Hydrate via cache only (no token available here)
        const cache = await hydrateTracks(async () => null, m.tracks.map((t) => t.trackUri));
        setTrackCache(cache);
      } catch { setError("Failed to load mixtape"); }
      finally { setLoading(false); }
    })();
  }, [shareToken]);

  const theme = mixtape?.theme ?? "rose";
  const totalNotes = mixtape?.notes.length ?? 0;

  const tracksWithMeta = useMemo(() => {
    if (!mixtape) return [] as { uri: string; cached: CachedTrack | undefined; notes: Mixtape["notes"]; effective: ReturnType<typeof resolveEdit> }[];
    const m = mixtape;
    return m.tracks.map((t) => {
      const cached = trackCache.get(t.trackUri);
      return {
        uri: t.trackUri,
        cached,
        notes: m.notes.filter((n) => n.trackUri === t.trackUri),
        effective: resolveEdit(t, null, cached?.durationMs ?? null),
      };
    });
  }, [mixtape, trackCache]);

  const handlePlay = async () => {
    if (!mixtape || !onPlay) return;
    const uris = mixtape.tracks.map((t) => t.trackUri);
    const af = await getAudioFeaturesCached(async () => null, uris);
    const vMap = new Map<string, TrackVersion>();
    for (const uri of [...new Set(uris)]) {
      const list = await fetchTrackVersions(mixtape.userId, uri);
      for (const v of list) vMap.set(v.id, v);
    }
    onPlay({ mixtape, trackCache, audioFeatures: af, versions: vMap });
  };

  if (loading) {
    return (
      <div className="login-shell">
        <h1 className="login-logo">Lovify</h1>
        <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
      </div>
    );
  }

  if (error || !mixtape) {
    return (
      <div className="login-shell">
        <h1 className="login-logo">Lovify</h1>
        <div className="error-box" style={{ maxWidth: 400, marginTop: 16 }}>{error || "Not found"}</div>
        <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: 16 }}>Go Home</button>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: mixtape.backgroundImageUrl
        ? `url(${mixtape.backgroundImageUrl}) center/cover fixed`
        : "var(--bg)",
    }}>
      {mixtape.backgroundImageUrl && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 0 }} />
      )}

      <div style={{ position: "relative", zIndex: 1, maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>← Home</button>

        <div style={{
          borderRadius: 20, overflow: "hidden",
          background: "var(--card)", border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
        }}>
          <div style={{
            height: 260,
            background: mixtape.coverImageUrl
              ? `url(${mixtape.coverImageUrl}) center/cover`
              : `linear-gradient(135deg, var(--${theme}) 0%, var(--bg) 100%)`,
            position: "relative",
          }}>
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(transparent 30%, rgba(0,0,0,0.85) 100%)",
              display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 28,
            }}>
              <h1 style={{
                fontFamily: "'Playfair Display', serif", fontSize: "2rem", fontWeight: 700,
                letterSpacing: "-0.02em",
              }}>{mixtape.name || "Untitled Mixtape"}</h1>
              {mixtape.recipientName && (
                <div style={{ fontSize: "0.9rem", color: "rgba(255,255,255,0.7)", marginTop: 6 }}>
                  for {mixtape.recipientName}
                </div>
              )}
            </div>
          </div>

          {mixtape.message && (
            <div style={{
              padding: "20px 28px", borderBottom: "1px solid var(--border)",
              fontStyle: "italic", color: "var(--text-secondary)",
              fontSize: "0.92rem", lineHeight: 1.5,
            }}>"{mixtape.message}"</div>
          )}

          <div style={{ padding: "8px 0" }}>
            {tracksWithMeta.map(({ uri, cached, notes, effective }, i) => (
              <div key={uri}>
                <div className="track-row" style={{ padding: "8px 20px" }}>
                  <span className="track-rank">{i + 1}</span>
                  {cached?.albumArtUrl
                    ? <img className="track-art" src={cached.albumArtUrl} alt="" style={{ width: 40, height: 40 }} />
                    : <div className="track-art-placeholder" style={{ width: 40, height: 40 }}>♫</div>}
                  <div className="track-info">
                    <span className="track-name" style={{ fontSize: "0.85rem" }}>{cached?.name ?? "Unknown"}</span>
                    <span className="track-artist">{cached?.artists ?? ""}</span>
                  </div>
                  <span className="track-duration">
                    {cached ? formatDuration(cached.durationMs - effective.skipRegions.reduce((s, r) => s + (r.end - r.start), 0)) : ""}
                  </span>
                </div>

                {notes.length > 0 && (
                  <div style={{ paddingLeft: 72, paddingRight: 20, paddingBottom: 8 }}>
                    {notes.map((n) => (
                      <div key={n.id}>
                        {n.imageUrl && (
                          <img src={n.imageUrl} alt=""
                            style={{
                              width: "100%", maxWidth: 280, maxHeight: 180,
                              objectFit: "cover", borderRadius: 10,
                              marginBottom: 6, display: "block",
                            }} />
                        )}
                        {(n.text || n.timestampMs != null) && (
                          <div style={{
                            display: "flex", alignItems: "center", gap: 8,
                            padding: "4px 10px", borderRadius: 8,
                            background: `var(--${n.color}-dim, var(--rose-dim))`,
                            fontSize: "0.78rem", marginBottom: 4,
                          }}>
                            <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.6, minWidth: 32 }}>
                              {fmt(n.timestampMs)}
                            </span>
                            <span style={{ color: `var(--${n.color}, var(--rose))` }}>
                              {n.emoji && `${n.emoji} `}{n.text}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{
            padding: "16px 28px", borderTop: "1px solid var(--border)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontSize: "0.78rem", color: "var(--text-muted)",
          }}>
            <span>{mixtape.tracks.length} tracks · {totalNotes} notes</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {onPlay && (
                <button className="btn btn-primary btn-sm" onClick={handlePlay}>▶ Play</button>
              )}
              <span style={{ color: `var(--${theme})` }}>made with Lovify ♡</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
