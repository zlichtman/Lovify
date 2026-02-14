import { useState, useEffect } from "react";
import { fetchTopTracks, type SpotifyTrack } from "../spotify/api";
import { TrackRow } from "../components/TrackRow";

type RangeData = {
  key: string;
  label: string;
  tracks: SpotifyTrack[];
  loading: boolean;
  error: string | null;
};

const RANGES = [
  { key: "short_term", label: "4 Weeks" },
  { key: "medium_term", label: "6 Months" },
  { key: "long_term", label: "All Time" },
] as const;

type Props = { getToken: () => Promise<string | null> };

export function Statify({ getToken }: Props) {
  const [columns, setColumns] = useState<RangeData[]>(
    RANGES.map((r) => ({ key: r.key, label: r.label, tracks: [], loading: true, error: null }))
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const token = await getToken();
      if (!token || cancelled) return;

      // Fetch all 3 ranges in parallel
      const results = await Promise.allSettled(
        RANGES.map((r) => fetchTopTracks(token, r.key, 50))
      );

      if (cancelled) return;

      setColumns(
        RANGES.map((r, i) => {
          const result = results[i];
          if (result.status === "fulfilled") {
            return { key: r.key, label: r.label, tracks: result.value, loading: false, error: null };
          }
          return { key: r.key, label: r.label, tracks: [], loading: false, error: "Failed to load" };
        })
      );
    })();

    return () => { cancelled = true; };
  }, [getToken]);

  const allLoading = columns.every((c) => c.loading);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Statify</h1>
        <p className="page-subtitle">your listening profile</p>
      </div>

      {allLoading ? (
        <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
      ) : (
        <div className="stats-columns">
          {columns.map((col) => (
            <div key={col.key} className="stats-column">
              <div className="stats-column-header">{col.label}</div>

              {col.loading ? (
                <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
              ) : col.error ? (
                <div className="error-box">{col.error}</div>
              ) : col.tracks.length === 0 ? (
                <div className="empty" style={{ padding: 24 }}>
                  <span className="empty-icon" style={{ fontSize: "1.5rem" }}>&#9835;</span>
                  <p style={{ fontSize: "0.8rem" }}>No tracks</p>
                </div>
              ) : (
                col.tracks.map((track, i) => (
                  <TrackRow key={`${col.key}-${track.id}-${i}`} track={track} rank={i + 1} />
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
