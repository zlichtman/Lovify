import { albumArt, formatDuration, type SpotifyTrack } from "../spotify/api";

type Props = {
  track: SpotifyTrack;
  rank?: number;
  actions?: React.ReactNode;
  onClick?: () => void;
};

export function TrackRow({ track, rank, actions, onClick }: Props) {
  const art = albumArt(track.album?.images, "small");
  return (
    <div className="track-row" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      {rank != null && <span className="track-rank">{rank}</span>}
      {art ? <img className="track-art" src={art} alt="" /> : <div className="track-art-placeholder">♫</div>}
      <div className="track-info">
        <span className="track-name">{track.name}</span>
        <span className="track-artist">{track.artists?.map((a) => a.name).join(", ")}</span>
      </div>
      <span className="track-duration">{formatDuration(track.duration_ms)}</span>
      {actions && <div className="track-actions">{actions}</div>}
    </div>
  );
}
