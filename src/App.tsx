import { useCallback, useEffect, useState } from "react";
import { fetchMe, type SpotifyUser } from "./spotify/api";
import { beginLogin, clearSession, exchangeCodeForToken, getValidAccessToken, saveSession } from "./spotify/auth";
import { Statify } from "./pages/Statify";
import { LovifyPage } from "./pages/Lovify";
import { Backupify } from "./pages/Backupify";
import { MixtapeView } from "./pages/MixtapeView";
import { PlayerProvider, usePlayer } from "./player/PlayerContext";
import { Visualizer } from "./player/Visualizer";
import type { Mixtape, TrackVersion } from "./supabase/api";
import type { CachedTrack, CachedAudioFeatures } from "./supabase/cache";

type Tab = "stats" | "mixtapes" | "backups";

const TABS: { id: Tab; label: string }[] = [
  { id: "stats", label: "Stats" },
  { id: "backups", label: "Backups" },
  { id: "mixtapes", label: "Mixtapes" },
];

function useClientId() {
  return import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim() || undefined;
}

function getShareToken(): string | null {
  const path = window.location.pathname;
  const match = path.match(/^\/mix\/([a-f0-9]+)$/);
  return match ? match[1] : null;
}

type PlayPayload = {
  mixtape: Mixtape;
  trackCache: Map<string, CachedTrack>;
  audioFeatures: Map<string, CachedAudioFeatures>;
  versions: Map<string, TrackVersion>;
};

/** Connects the Web Playback SDK as soon as we have a signed-in user,
 * so the device is ready by the time the user clicks Play on a mixtape. */
function PlayerBoot({ getToken }: { getToken: () => Promise<string | null> }) {
  const player = usePlayer();
  useEffect(() => {
    void player.connect(getToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function App() {
  const clientId = useClientId();
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [tab, setTab] = useState<Tab>("stats");
  const [shareToken] = useState(getShareToken);
  const [playing, setPlaying] = useState<PlayPayload | null>(null);

  const loadUser = useCallback(async () => {
    if (!clientId) return;
    const token = await getValidAccessToken(clientId);
    if (!token) { setUser(null); return; }
    try {
      setUser(await fetchMe(token));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load profile");
      clearSession();
      setUser(null);
    }
  }, [clientId]);

  useEffect(() => {
    if (!clientId) { setBusy(false); return; }
    const path = window.location.pathname;
    if (path === "/callback" || path.endsWith("/callback")) {
      const params = new URLSearchParams(window.location.search);
      const spotifyError = params.get("error");
      const code = params.get("code");
      if (spotifyError) { setError(`Spotify: ${spotifyError}`); window.history.replaceState({}, "", "/"); setBusy(false); return; }
      if (!code) { setError("No authorization code."); window.history.replaceState({}, "", "/"); setBusy(false); return; }
      void (async () => {
        try {
          const tokens = await exchangeCodeForToken(code, clientId);
          saveSession(tokens, clientId);
          window.history.replaceState({}, "", "/");
          await loadUser();
        } catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed"); window.history.replaceState({}, "", "/"); }
        finally { setBusy(false); }
      })();
    } else {
      void loadUser().finally(() => setBusy(false));
    }
  }, [clientId, loadUser]);

  const getToken = useCallback(async () => {
    if (!clientId) return null;
    const token = await getValidAccessToken(clientId);
    if (!token) { clearSession(); setUser(null); return null; }
    return token;
  }, [clientId]);

  if (shareToken) {
    return (
      <PlayerProvider>
        {user && <PlayerBoot getToken={getToken} />}
        <MixtapeView
          shareToken={shareToken}
          onBack={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }}
          onPlay={user ? (p) => setPlaying(p) : undefined}
        />
        {playing && (
          <Visualizer
            mixtape={playing.mixtape}
            trackCache={playing.trackCache}
            audioFeatures={playing.audioFeatures}
            versions={playing.versions}
            getToken={getToken}
            onClose={() => setPlaying(null)}
          />
        )}
      </PlayerProvider>
    );
  }

  if (busy) return (
    <div className="login-shell">
      <h1 className="login-logo">Lovify</h1>
      <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
    </div>
  );

  if (!clientId) return (
    <div className="login-shell">
      <h1 className="login-logo">Lovify</h1>
      <div className="login-card"><p>Set <code>VITE_SPOTIFY_CLIENT_ID</code> in <code>.env</code></p></div>
    </div>
  );

  if (!user) return (
    <div className="login-shell">
      <h1 className="login-logo">Lovify</h1>
      <p className="login-tagline">your music, with love</p>
      {error && <div className="error-box" style={{ maxWidth: 400, marginBottom: 16 }}>{error}</div>}
      <div className="login-card">
        <span className="login-icon">♡</span>
        <p>Sign in with Spotify to access your music</p>
        <button className="btn btn-primary" onClick={() => void beginLogin(clientId)}>Connect with Spotify</button>
      </div>
    </div>
  );

  return (
    <PlayerProvider>
      <PlayerBoot getToken={getToken} />
      <div className="shell">
        <main className="main-full">
          {tab === "stats" && <Statify getToken={getToken} />}
          {tab === "mixtapes" && (
            <LovifyPage getToken={getToken} userId={user.id} onPlay={setPlaying} />
          )}
          {tab === "backups" && <Backupify getToken={getToken} userId={user.id} />}
        </main>

        {playing && (
          <Visualizer
            mixtape={playing.mixtape}
            trackCache={playing.trackCache}
            audioFeatures={playing.audioFeatures}
            versions={playing.versions}
            getToken={getToken}
            onClose={() => setPlaying(null)}
          />
        )}

        <nav className="bottomnav">
          <div className="bottomnav-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`bottomnav-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="bottomnav-user">
            <span>{user.display_name}</span>
            <button className="bottomnav-logout" onClick={() => { clearSession(); setUser(null); }}>Sign out</button>
          </div>
        </nav>
      </div>
    </PlayerProvider>
  );
}
