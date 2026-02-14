import type { MixtapeSummary } from "../supabase/api";

type Props = {
  mixtape: MixtapeSummary;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onPlay: () => void;
};

const THEME_GRADIENTS: Record<string, string> = {
  rose: "linear-gradient(135deg, #e8457c 0%, #c13366 100%)",
  violet: "linear-gradient(135deg, #9c5bd2 0%, #7b3db5 100%)",
  amber: "linear-gradient(135deg, #e8a034 0%, #c48020 100%)",
  emerald: "linear-gradient(135deg, #3dba8a 0%, #2a9a6e 100%)",
  sky: "linear-gradient(135deg, #4ca4e8 0%, #3480c4 100%)",
  slate: "linear-gradient(135deg, #8c8ea0 0%, #6a6c80 100%)",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });
}

export function MixtapeCard({ mixtape, onEdit, onDelete, onShare, onPlay }: Props) {
  const coverSrc = mixtape.coverImageUrl || mixtape.firstTrackArt;
  const gradient = THEME_GRADIENTS[mixtape.theme] || THEME_GRADIENTS.rose;

  return (
    <div
      className="card card-interactive"
      style={{ padding: 0, overflow: "hidden", cursor: "pointer" }}
      onClick={onEdit}
    >
      {/* Cover area */}
      <div style={{
        height: 140, position: "relative",
        background: coverSrc ? `url(${coverSrc}) center/cover` : gradient,
        display: "flex", alignItems: "flex-end",
      }}>
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(transparent 40%, rgba(0,0,0,0.7) 100%)",
        }} />
        <div style={{ position: "relative", padding: "12px 16px", width: "100%" }}>
          <div style={{ fontWeight: 700, fontSize: "1rem", textShadow: "0 1px 4px rgba(0,0,0,0.5)" }}>
            {mixtape.name || "Untitled Mixtape"}
          </div>
          {mixtape.recipientName && (
            <div style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.7)", marginTop: 2 }}>
              for {mixtape.recipientName}
            </div>
          )}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="badge">{mixtape.trackCount} tracks</span>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{formatDate(mixtape.createdAt)}</span>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); onPlay(); }} title="Play">
              &#9654;
            </button>
            <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); onShare(); }} title="Share">
              &#128279;
            </button>
            <button
              className="btn btn-ghost btn-xs"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title="Delete"
              style={{ color: "var(--text-muted)" }}
            >
              &#128465;
            </button>
          </div>
        </div>
        {mixtape.message && (
          <div style={{
            marginTop: 8, fontSize: "0.78rem", color: "var(--text-secondary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            "{mixtape.message}"
          </div>
        )}
      </div>
    </div>
  );
}
