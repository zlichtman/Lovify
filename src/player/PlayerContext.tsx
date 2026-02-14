import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type CurrentTrack = {
  name: string;
  artists: string;
  albumArt: string | null;
  duration: number;
  uri: string;
};

type PlayerState = {
  /** true once the Web Playback SDK has registered a device_id */
  isReady: boolean;
  /** true after activateElement() has been called inside a user gesture */
  isActivated: boolean;
  isPaused: boolean;
  currentTrack: CurrentTrack | null;
  position: number;
  deviceId: string | null;
  playError: string | null;
};

type PlayerActions = {
  connect: (getToken: () => Promise<string | null>) => Promise<void>;
  disconnect: () => void;
  /** Must be called from inside a user-gesture handler (click/keyup). Idempotent. */
  activate: () => void;
  togglePlay: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  seek: (ms: number) => void;
  playTrack: (uri: string) => Promise<void>;
  playUris: (uris: string[], offset?: number) => Promise<void>;
};

type PlayerContextValue = PlayerState & PlayerActions;

const PlayerCtx = createContext<PlayerContextValue | null>(null);

export function usePlayer() {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be inside PlayerProvider");
  return ctx;
}

// ── Helpers ──

const SPOTIFY_API = "https://api.spotify.com/v1";

function parsePlayError(status: number, body: string): string {
  if (status === 403) return "Spotify Premium is required to play tracks.";
  if (status === 401) return "Session expired — please sign out and back in.";
  if (status === 404) return "Device not ready — tap Play again.";
  try {
    const json = JSON.parse(body);
    return json?.error?.message ?? `Playback error (${status})`;
  } catch {
    return `Playback error (${status})`;
  }
}

/**
 * Transfer playback to our device. Used as a fallback when /me/player/play?device_id=X
 * returns 404; the explicit transfer nudges Spotify to recognize the dormant SDK device.
 * Per community guidance, a separate boot-time transfer is NOT needed — the first
 * /me/player/play call with ?device_id=X activates the device implicitly.
 */
async function transferPlayback(token: string, deviceId: string, play: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${SPOTIFY_API}/me/player`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play }),
    });
    return res.ok || res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

// ── Provider ──

export function PlayerProvider({ children }: { children: ReactNode }) {
  const playerRef = useRef<Spotify.Player | null>(null);
  const getTokenRef = useRef<(() => Promise<string | null>) | null>(null);
  const positionTimer = useRef<number | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const activatedRef = useRef(false);
  const connectingRef = useRef(false);

  const [isReady, setIsReady] = useState(false);
  const [isActivated, setIsActivated] = useState(false);
  const [isPaused, setIsPaused] = useState(true);
  const [currentTrack, setCurrentTrack] = useState<CurrentTrack | null>(null);
  const [position, setPosition] = useState(0);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);

  // Poll getCurrentState() for smooth position updates. This is a local JS call,
  // no HTTP, so 250ms is safe. Only runs while playing.
  useEffect(() => {
    if (!isReady || isPaused) {
      if (positionTimer.current) clearInterval(positionTimer.current);
      positionTimer.current = null;
      return;
    }
    positionTimer.current = window.setInterval(async () => {
      const raw = await playerRef.current?.getCurrentState();
      const state = raw as { position: number; paused: boolean } | null;
      if (state) {
        setPosition(state.position);
        if (state.paused !== isPaused) setIsPaused(state.paused);
      }
    }, 250);
    return () => {
      if (positionTimer.current) clearInterval(positionTimer.current);
    };
  }, [isReady, isPaused]);

  useEffect(() => {
    return () => {
      playerRef.current?.disconnect();
      if (positionTimer.current) clearInterval(positionTimer.current);
    };
  }, []);

  const connect = useCallback(async (getToken: () => Promise<string | null>) => {
    if (connectingRef.current || playerRef.current) return;
    connectingRef.current = true;

    try {
      if (!window.Spotify) {
        const ready = (window as { __spotifySDKReady?: Promise<void> }).__spotifySDKReady;
        if (ready) await ready;
        if (!window.Spotify) {
          setPlayError("Spotify SDK failed to load. Check ad-blockers and refresh.");
          return;
        }
      }
      getTokenRef.current = getToken;

      const token = await getToken();
      if (!token) { setPlayError("No Spotify token — please sign in again."); return; }

      setPlayError(null);

      const player = new window.Spotify.Player({
        name: "Lovify Web Player",
        getOAuthToken: (cb) => {
          if (!getTokenRef.current) return;
          void getTokenRef.current().then((t) => { if (t) cb(t); });
        },
        volume: 0.8,
      });

      player.addListener("ready", (e) => {
        const id = (e as { device_id: string }).device_id;
        console.log("[Lovify] SDK ready:", id);
        setDeviceId(id);
        deviceIdRef.current = id;
        setIsReady(true);
      });

      // The SDK auto-reconnects its WebSocket on transient drops (tab background,
      // network blip, screen lock on mobile). We just flip the ready flag and
      // wait for `ready` to fire again — re-transferring here would 404 because
      // the WS is gone.
      player.addListener("not_ready", () => {
        console.warn("[Lovify] Device not ready (SDK will auto-reconnect)");
        setIsReady(false);
      });

      player.addListener("player_state_changed", (state) => {
        if (!state) {
          setCurrentTrack(null);
          setIsPaused(true);
          return;
        }
        const s = state as {
          paused: boolean;
          position: number;
          track_window: {
            current_track: {
              name: string;
              artists: { name: string }[];
              album: { images: { url: string }[] };
              duration_ms: number;
              uri: string;
            };
          };
        };
        const ct = s.track_window.current_track;
        setCurrentTrack({
          name: ct.name,
          artists: ct.artists.map((a) => a.name).join(", "),
          albumArt: ct.album.images?.[0]?.url ?? null,
          duration: ct.duration_ms,
          uri: ct.uri,
        });
        setPosition(s.position);
        setIsPaused(s.paused);
        setPlayError(null);
      });

      player.addListener("initialization_error", (e) => {
        console.error("[Lovify] init_error:", e);
        setIsReady(false);
        setPlayError(`Init failed: ${(e as { message?: string })?.message ?? "unknown"}`);
      });
      player.addListener("authentication_error", (e) => {
        console.error("[Lovify] auth_error:", e);
        setIsReady(false);
        setPlayError("Spotify auth failed — sign out and back in.");
      });
      player.addListener("account_error", () => {
        setIsReady(false);
        setPlayError("Spotify Premium is required to use the Web Player.");
      });

      const ok = await player.connect();
      if (ok) {
        playerRef.current = player;
      } else {
        setPlayError("SDK connect() failed. Check Premium status, HTTPS, and ad-blockers.");
      }
    } finally {
      connectingRef.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    playerRef.current?.disconnect();
    playerRef.current = null;
    setIsReady(false);
    setIsActivated(false);
    activatedRef.current = false;
    setCurrentTrack(null);
    setIsPaused(true);
    setDeviceId(null);
    setPlayError(null);
  }, []);

  /**
   * activateElement unlocks the <audio> element for autoplay policies on
   * iOS/Safari/mobile Chrome. It MUST be invoked inside a user-gesture
   * handler — at construction time it silently no-ops on mobile and the
   * device then refuses to play. Idempotent; safe to call multiple times.
   */
  const activate = useCallback(() => {
    if (activatedRef.current || !playerRef.current) return;
    playerRef.current.activateElement();
    activatedRef.current = true;
    setIsActivated(true);
  }, []);

  const togglePlay = useCallback(() => { playerRef.current?.togglePlay(); }, []);
  const nextTrack = useCallback(() => { playerRef.current?.nextTrack(); }, []);
  const prevTrack = useCallback(() => { playerRef.current?.previousTrack(); }, []);
  const seek = useCallback((ms: number) => { playerRef.current?.seek(ms); }, []);

  /**
   * Send a play command. Tries /me/player/play?device_id=X first — that call
   * is documented to activate a dormant SDK device. On 404, falls back to a
   * transfer+play sequence. Includes exponential backoff on transient 502s
   * that the community has seen sporadically.
   */
  const doPlay = useCallback(async (body: object): Promise<void> => {
    const did = deviceIdRef.current;
    if (!did || !getTokenRef.current) {
      setPlayError("Player not ready yet.");
      return;
    }
    // Safety net: if caller forgot activate() we still try once.
    if (!activatedRef.current && playerRef.current) {
      try { playerRef.current.activateElement(); activatedRef.current = true; setIsActivated(true); } catch { /* ignore */ }
    }

    const token = await getTokenRef.current();
    if (!token) { setPlayError("Session expired — sign in again."); return; }

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${SPOTIFY_API}/me/player/play?device_id=${did}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok || res.status === 204) {
        setPlayError(null);
        return;
      }

      const respBody = await res.text();
      console.error(`[Lovify] play attempt ${attempt + 1} → ${res.status}:`, respBody);

      if ((res.status === 404 || res.status === 502) && attempt < 3) {
        // Device dormant or Spotify hiccup — transfer with play:true, wait, retry.
        await transferPlayback(token, did, true);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }

      setPlayError(parsePlayError(res.status, respBody));
      return;
    }
  }, []);

  const playTrack = useCallback(async (uri: string) => {
    await doPlay({ uris: [uri] });
  }, [doPlay]);

  const playUris = useCallback(async (uris: string[], offset = 0) => {
    const slicedUris = offset > 0 ? uris.slice(offset) : uris;
    await doPlay({ uris: slicedUris });
  }, [doPlay]);

  return (
    <PlayerCtx.Provider value={{
      isReady, isActivated, isPaused, currentTrack, position, deviceId, playError,
      connect, disconnect, activate, togglePlay, nextTrack, prevTrack, seek, playTrack, playUris,
    }}>
      {children}
    </PlayerCtx.Provider>
  );
}
