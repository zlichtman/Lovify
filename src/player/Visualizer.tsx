import { useEffect, useRef, useMemo } from "react";
import { usePlayer } from "./PlayerContext";
import { formatDuration } from "../spotify/api";
import type { Mixtape, MixtapeNote, TrackVersion } from "../supabase/api";
import type { CachedTrack, CachedAudioFeatures } from "../supabase/cache";
import { usePlaybackEngine } from "../mixtape/PlaybackEngine";

type Props = {
  mixtape: Mixtape;
  trackCache: Map<string, CachedTrack>;
  audioFeatures: Map<string, CachedAudioFeatures>;
  versions: Map<string, TrackVersion>;
  getToken: () => Promise<string | null>;
  onClose: () => void;
};

const THEME_RGB: Record<string, string> = {
  rose: "232,69,124",
  violet: "156,91,210",
  amber: "232,160,52",
  emerald: "61,186,138",
  sky: "76,164,232",
  slate: "140,142,160",
};

export function Visualizer({
  mixtape, trackCache, audioFeatures, versions, getToken, onClose,
}: Props) {
  const player = usePlayer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  const theme = mixtape.theme || "rose";
  const themeRgb = THEME_RGB[theme] ?? THEME_RGB.rose;

  const durations = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of mixtape.tracks) {
      const c = trackCache.get(t.trackUri);
      if (c) m.set(t.trackUri, c.durationMs);
    }
    return m;
  }, [mixtape.tracks, trackCache]);

  usePlaybackEngine({ mixtape, versions, durations, enabled: true });

  const mixtapeUris = useMemo(() => mixtape.tracks.map((t) => t.trackUri), [mixtape.tracks]);
  const mixtapeUriSet = useMemo(() => new Set(mixtapeUris), [mixtapeUris]);

  // Kick a connect in case user hit Play before PlayerBoot finished (first load).
  useEffect(() => {
    if (!player.isReady && !player.deviceId) void player.connect(getToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** MUST be called synchronously from a user-gesture handler (click). */
  const handlePlayMixtape = () => {
    player.activate();
    void player.playUris(mixtapeUris, 0);
  };

  const isPlayingMixtape = !!player.currentTrack && mixtapeUriSet.has(player.currentTrack.uri);

  // Active notes for current track
  const currentUri = player.currentTrack?.uri ?? null;
  const trackNotes = useMemo(
    () => (currentUri ? mixtape.notes.filter((n) => n.trackUri === currentUri) : []),
    [mixtape.notes, currentUri],
  );
  const activeNotes = useMemo(() => {
    if (!player.currentTrack || player.isPaused) return [] as MixtapeNote[];
    return trackNotes.filter((n) =>
      player.position >= n.timestampMs && player.position < n.timestampMs + n.durationMs,
    );
  }, [trackNotes, player.position, player.currentTrack, player.isPaused]);

  // ── Canvas: tempo-driven bars + ambient particles ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const uri = player.currentTrack?.uri ?? "";
      const af = audioFeatures.get(uri);
      const tempo = af?.tempo ?? 120;
      const energy = af?.energy ?? 0.5;
      const valence = af?.valence ?? 0.5;

      // Blend theme color toward energy/valence (brighter + hue-shifted with higher energy)
      const activeRgb = activeNotes[0]?.color
        ? (THEME_RGB[activeNotes[0].color] ?? themeRgb)
        : themeRgb;

      const t = Date.now() / 1000;
      const beat = (t * tempo / 60) % 1;           // 0→1 across each beat
      const pulse = Math.pow(1 - beat, 2);         // sharp attack, slow decay

      // ── Ambient particles ──
      for (let i = 0; i < 24; i++) {
        const x = (Math.sin(t * 0.3 + i * 0.7) * 0.5 + 0.5) * w;
        const y = (Math.cos(t * 0.2 + i * 1.1) * 0.5 + 0.5) * h;
        const r = 2 + Math.sin(t + i) * 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${activeRgb},${0.08 + valence * 0.08})`;
        ctx.fill();
      }

      // ── Tempo bars across bottom ──
      const bars = 48;
      const barW = w / bars;
      for (let i = 0; i < bars; i++) {
        // Per-bar height driven by tempo pulse + positional noise + energy
        const phase = (beat + i / bars) % 1;
        const boost = Math.pow(1 - phase, 3);
        const noise = (Math.sin(t * 2 + i * 0.4) * 0.5 + 0.5) * 0.3;
        const amp = (boost * 0.8 + noise) * (0.3 + energy * 0.7);
        const barH = amp * h * 0.35;
        const alpha = 0.3 + energy * 0.4;
        const grad = ctx.createLinearGradient(0, h - barH, 0, h);
        grad.addColorStop(0, `rgba(${activeRgb},${alpha})`);
        grad.addColorStop(1, `rgba(${activeRgb},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(i * barW + 1, h - barH, barW - 2, barH);
      }

      // ── Centered pulsing ring ──
      const ringR = 140 + pulse * 60 * (0.5 + energy);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${activeRgb},${0.06 + pulse * 0.15})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [player.currentTrack, audioFeatures, themeRgb, activeNotes]);

  const progressPct = player.currentTrack
    ? Math.min((player.position / player.currentTrack.duration) * 100, 100)
    : 0;

  const hasImageNote = activeNotes.some((n) => n.imageUrl);

  const currentTrackCached = currentUri ? trackCache.get(currentUri) : undefined;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 500,
      background: mixtape.backgroundImageUrl
        ? `url(${mixtape.backgroundImageUrl}) center/cover`
        : "var(--bg)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    }}>
      {mixtape.backgroundImageUrl && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.7)" }} />
      )}

      <canvas ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />

      <button className="btn btn-ghost" onClick={onClose}
        style={{ position: "absolute", top: 16, right: 16, zIndex: 10, fontSize: "1.2rem" }}>×</button>

      <div style={{ position: "absolute", top: 20, left: 24, zIndex: 10,
        fontSize: "0.85rem", color: "var(--text-secondary)" }}>
        {mixtape.name}
      </div>

      <div style={{
        position: "relative", zIndex: 5, textAlign: "center",
        maxWidth: 440, width: "100%", padding: "0 16px",
      }}>
        {player.playError ? (
          <div style={{ textAlign: "center", padding: "0 24px" }}>
            <p style={{ color: "var(--rose)", fontWeight: 600, marginBottom: 8 }}>Playback failed</p>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: 16 }}>{player.playError}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="btn btn-primary btn-sm" onClick={handlePlayMixtape}>Retry</button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => { player.disconnect(); await player.connect(getToken); }}
              >Reset player</button>
            </div>
          </div>
        ) : !player.isReady ? (
          <div style={{ textAlign: "center" }}>
            <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
            <p style={{ marginTop: 16, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
              Connecting to Spotify...
            </p>
          </div>
        ) : !player.isActivated || (player.currentTrack && !isPlayingMixtape) ? (
          <div style={{ textAlign: "center", padding: "0 24px" }}>
            {player.currentTrack && !isPlayingMixtape ? (
              <>
                <p style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 8 }}>Different track playing</p>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: 16 }}>
                  Spotify is on <strong>{player.currentTrack.name}</strong>. Switch to this mixtape to see notes and skips.
                </p>
              </>
            ) : (
              <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: 16 }}>
                Tap to start the mixtape. Keep this window open — notes, images, and skips happen here.
              </p>
            )}
            <button className="btn btn-primary" style={{ padding: "12px 28px", fontSize: "1rem" }} onClick={handlePlayMixtape}>
              ▶ Play mixtape
            </button>
          </div>
        ) : player.currentTrack ? (
          <>
            {hasImageNote && (
              <div style={{ marginBottom: 20 }}>
                {activeNotes.filter((n) => n.imageUrl).map((n) => (
                  <img key={n.id} src={n.imageUrl!} alt=""
                    style={{
                      width: "100%", maxWidth: 360, maxHeight: 280,
                      objectFit: "cover", borderRadius: 16,
                      boxShadow: `0 8px 40px rgba(0,0,0,0.5), 0 0 60px var(--${n.color}-dim, rgba(232,69,124,0.15))`,
                    }} />
                ))}
              </div>
            )}

            <div style={{
              width: hasImageNote ? 80 : 260,
              height: hasImageNote ? 80 : 260,
              margin: hasImageNote ? "0 auto 16px" : "0 auto 24px",
              borderRadius: hasImageNote ? 12 : 20,
              background: (currentTrackCached?.albumArtUrl ?? player.currentTrack.albumArt)
                ? `url(${currentTrackCached?.albumArtUrl ?? player.currentTrack.albumArt}) center/cover`
                : `linear-gradient(135deg, var(--${theme}) 0%, var(--bg) 100%)`,
              boxShadow: `0 8px 40px rgba(0,0,0,0.4), 0 0 60px var(--${theme}-dim, rgba(232,69,124,0.1))`,
              transition: "all 0.5s ease",
            }} />

            <h2 style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: hasImageNote ? "1rem" : "1.3rem", fontWeight: 700, marginBottom: 4,
            }}>{player.currentTrack.name}</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginBottom: 20 }}>
              {player.currentTrack.artists}
            </p>

            {activeNotes.filter((n) => n.text).map((n) => (
              <div key={n.id} style={{
                padding: "12px 20px", borderRadius: 14,
                background: `var(--${n.color}-dim, var(--rose-dim))`,
                border: "1px solid rgba(255,255,255,0.08)",
                backdropFilter: "blur(12px)", marginBottom: 12,
              }}>
                {n.emoji && <span style={{ fontSize: "1.3rem", display: "block", marginBottom: 6 }}>{n.emoji}</span>}
                <span style={{ color: `var(--${n.color}, var(--rose))`, fontSize: "1rem", fontWeight: 500 }}>
                  {n.text}
                </span>
              </div>
            ))}

            <div style={{
              width: "100%", marginTop: 16, padding: "16px 0",
              borderRadius: 16, background: "rgba(0,0,0,0.3)", backdropFilter: "blur(20px)",
            }}>
              <div style={{ padding: "0 16px", marginBottom: 8 }}>
                <div
                  style={{
                    position: "relative", height: 4,
                    background: "rgba(255,255,255,0.1)", borderRadius: 2, cursor: "pointer",
                  }}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = (e.clientX - rect.left) / rect.width;
                    player.seek(Math.round(pct * (player.currentTrack?.duration ?? 0)));
                  }}
                >
                  <div style={{
                    width: `${progressPct}%`, height: "100%",
                    background: `var(--${theme})`, borderRadius: 2,
                    transition: "width 0.5s linear",
                    boxShadow: `0 0 8px var(--${theme})`,
                  }} />
                  {trackNotes.map((n) => player.currentTrack ? (
                    <div key={n.id} style={{
                      position: "absolute", top: -3,
                      left: `${(n.timestampMs / player.currentTrack.duration) * 100}%`,
                      width: 8, height: 8, borderRadius: "50%",
                      background: `var(--${n.color})`,
                      transform: "translateX(-50%)",
                      boxShadow: `0 0 6px var(--${n.color})`,
                    }} />
                  ) : null)}
                </div>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 4,
                }}>
                  <span>{formatDuration(player.position)}</span>
                  <span>{formatDuration(player.currentTrack.duration)}</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}>
                <button className="btn btn-ghost btn-icon" onClick={() => player.prevTrack()} style={{ fontSize: "1.2rem" }}>⏮</button>
                <button className="btn btn-primary btn-icon" onClick={() => player.togglePlay()} style={{ width: 56, height: 56, fontSize: "1.4rem" }}>
                  {player.isPaused ? "▶" : "⏸"}
                </button>
                <button className="btn btn-ghost btn-icon" onClick={() => player.nextTrack()} style={{ fontSize: "1.2rem" }}>⏭</button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ textAlign: "center" }}>
            <button className="btn btn-primary" style={{ padding: "12px 28px", fontSize: "1rem" }} onClick={handlePlayMixtape}>
              ▶ Play mixtape
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
