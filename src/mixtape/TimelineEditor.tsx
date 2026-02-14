import { useEffect, useMemo, useRef, useState } from "react";
import type { MixtapeNote, SkipRegion } from "../supabase/api";
import { normalizeSkips } from "./edits";

export type EditState = {
  skipRegions: SkipRegion[];
  fadeInMs: number;
  fadeOutMs: number;
};

type Props = {
  trackUri: string;
  trackDurationMs: number;
  edit: EditState;
  onChange: (next: EditState) => void;
  notes: MixtapeNote[];
  onNotesChange: (next: MixtapeNote[]) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
};

function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type DragKind =
  | { kind: "skip-start"; index: number }
  | { kind: "skip-end"; index: number }
  | { kind: "skip-move"; index: number; offset: number }
  | { kind: "note"; id: string }
  | null;

const COLORS = ["rose", "violet", "amber", "emerald", "sky"];

export function TimelineEditor({
  trackUri, trackDurationMs, edit, onChange, notes, onNotesChange, onUploadImage,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragKind>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const pxToMs = (px: number): number => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, px / rect.width));
    return Math.round(pct * trackDurationMs);
  };

  const msToPct = (ms: number): number =>
    Math.max(0, Math.min(100, (ms / trackDurationMs) * 100));

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const ms = Math.round(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * trackDurationMs);

      if (drag.kind === "skip-start") {
        const s = edit.skipRegions.slice();
        s[drag.index] = { ...s[drag.index], start: Math.min(ms, s[drag.index].end - 200) };
        onChange({ ...edit, skipRegions: normalizeSkips(s) });
      } else if (drag.kind === "skip-end") {
        const s = edit.skipRegions.slice();
        s[drag.index] = { ...s[drag.index], end: Math.max(ms, s[drag.index].start + 200) };
        onChange({ ...edit, skipRegions: normalizeSkips(s) });
      } else if (drag.kind === "skip-move") {
        const s = edit.skipRegions.slice();
        const orig = s[drag.index];
        const width = orig.end - orig.start;
        const newStart = Math.max(0, Math.min(trackDurationMs - width, ms - drag.offset));
        s[drag.index] = { start: newStart, end: newStart + width };
        onChange({ ...edit, skipRegions: normalizeSkips(s) });
      } else if (drag.kind === "note") {
        onNotesChange(notes.map((n) => n.id === drag.id ? { ...n, timestampMs: ms } : n));
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, edit, notes, onChange, onNotesChange, trackDurationMs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (hoverMs === null) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key.toLowerCase() === "s") { e.preventDefault(); addSkipAt(hoverMs); }
      else if (e.key.toLowerCase() === "n") { e.preventDefault(); addNoteAt(hoverMs); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hoverMs, edit, notes]);

  const addSkipAt = (ms: number) => {
    const width = Math.min(4000, trackDurationMs - ms);
    if (width < 200) return;
    const next = normalizeSkips([...edit.skipRegions, { start: ms, end: ms + width }]);
    onChange({ ...edit, skipRegions: next });
  };

  const skipToStart = () => {
    const existing = edit.skipRegions.find((r) => r.start === 0);
    const to = prompt("Skip from 0:00 up to (seconds):", existing ? String(existing.end / 1000) : "15");
    if (!to) return;
    const endMs = Math.max(500, Math.min(trackDurationMs - 500, Math.round(parseFloat(to) * 1000)));
    if (!Number.isFinite(endMs)) return;
    const rest = edit.skipRegions.filter((r) => r.start !== 0);
    onChange({ ...edit, skipRegions: normalizeSkips([{ start: 0, end: endMs }, ...rest]) });
  };

  const skipEnd = () => {
    const existing = edit.skipRegions.find((r) => r.end === trackDurationMs);
    const from = prompt("Skip the ending starting at (seconds):", existing ? String(existing.start / 1000) : String(Math.max(0, (trackDurationMs - 15000) / 1000)));
    if (!from) return;
    const startMs = Math.max(500, Math.min(trackDurationMs - 500, Math.round(parseFloat(from) * 1000)));
    if (!Number.isFinite(startMs)) return;
    const rest = edit.skipRegions.filter((r) => r.end !== trackDurationMs);
    onChange({ ...edit, skipRegions: normalizeSkips([...rest, { start: startMs, end: trackDurationMs }]) });
  };

  const addNoteAt = (ms: number) => {
    const note: MixtapeNote = {
      id: crypto.randomUUID(),
      trackUri,
      timestampMs: ms,
      durationMs: 5000,
      text: "",
      color: "rose",
      emoji: null,
      imageUrl: null,
      visualType: null,
    };
    onNotesChange([...notes, note]);
    setSelectedNoteId(note.id);
  };

  const removeSkip = (index: number) => {
    onChange({ ...edit, skipRegions: edit.skipRegions.filter((_, i) => i !== index) });
  };

  const removeNote = (id: string) => {
    onNotesChange(notes.filter((n) => n.id !== id));
    if (selectedNoteId === id) setSelectedNoteId(null);
  };

  const updateNote = (id: string, patch: Partial<MixtapeNote>) => {
    onNotesChange(notes.map((n) => n.id === id ? { ...n, ...patch } : n));
  };

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  const onBarMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const ms = pxToMs(e.nativeEvent.offsetX);
    if (e.shiftKey) addSkipAt(ms);
    else if (e.altKey) addNoteAt(ms);
  };

  const playable = useMemo(() => {
    // Compute playable total = duration - sum of skips
    const total = edit.skipRegions.reduce((s, r) => s + (r.end - r.start), 0);
    return Math.max(0, trackDurationMs - total);
  }, [edit.skipRegions, trackDurationMs]);

  return (
    <div className="timeline-editor" style={{ background: "var(--surface)", borderRadius: 12, padding: 14, marginTop: 10 }}>
      <div style={{
        display: "flex", gap: 8, alignItems: "center", fontSize: "0.75rem",
        color: "var(--text-muted)", marginBottom: 10, flexWrap: "wrap",
      }}>
        <span><kbd>S</kbd> / shift-click: skip</span>
        <span><kbd>N</kbd> / alt-click: note</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-ghost btn-xs" onClick={skipToStart}>skip intro…</button>
          <button className="btn btn-ghost btn-xs" onClick={skipEnd}>skip ending…</button>
        </span>
      </div>

      <div
        ref={barRef}
        onMouseDown={onBarMouseDown}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHoverMs(pxToMs(e.clientX - r.left));
        }}
        onMouseLeave={() => setHoverMs(null)}
        style={{
          position: "relative", height: 48,
          background: "linear-gradient(90deg, var(--rose-dim), rgba(232,69,124,0.25))",
          borderRadius: 8,
          cursor: "crosshair", userSelect: "none",
        }}
      >
        {edit.skipRegions.map((r, i) => (
          <div
            key={i}
            onMouseDown={(e) => {
              e.stopPropagation();
              const ms = pxToMs(e.nativeEvent.offsetX + (e.currentTarget as HTMLElement).offsetLeft);
              setDrag({ kind: "skip-move", index: i, offset: ms - r.start });
            }}
            onDoubleClick={(e) => { e.stopPropagation(); removeSkip(i); }}
            style={{
              position: "absolute",
              left: `${msToPct(r.start)}%`,
              width: `${msToPct(r.end) - msToPct(r.start)}%`,
              top: 0, bottom: 0,
              background: "repeating-linear-gradient(45deg, rgba(140,142,160,0.55) 0 4px, rgba(20,20,20,0.7) 4px 8px)",
              border: "1px solid rgba(140,142,160,0.6)", borderRadius: 4,
              cursor: "grab",
            }}
            title="Drag to move · Edge to resize · Double-click to delete"
          >
            <div
              onMouseDown={(e) => { e.stopPropagation(); setDrag({ kind: "skip-start", index: i }); }}
              style={{ position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "ew-resize" }}
            />
            <div
              onMouseDown={(e) => { e.stopPropagation(); setDrag({ kind: "skip-end", index: i }); }}
              style={{ position: "absolute", right: -4, top: 0, bottom: 0, width: 8, cursor: "ew-resize" }}
            />
          </div>
        ))}

        {notes.map((n) => (
          <div
            key={n.id}
            onMouseDown={(e) => { e.stopPropagation(); setDrag({ kind: "note", id: n.id }); setSelectedNoteId(n.id); }}
            onClick={(e) => { e.stopPropagation(); setSelectedNoteId(n.id); }}
            style={{
              position: "absolute", left: `${msToPct(n.timestampMs)}%`,
              transform: "translateX(-50%)",
              top: -10, bottom: -10, width: 14,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "grab", zIndex: 3,
            }}
          >
            <div style={{
              width: 12, height: 12, borderRadius: "50%",
              background: `var(--${n.color})`,
              border: selectedNoteId === n.id ? "2px solid #fff" : "2px solid rgba(0,0,0,0.4)",
              boxShadow: `0 0 6px var(--${n.color})`,
            }} />
          </div>
        ))}

        {hoverMs !== null && !drag && (
          <div style={{
            position: "absolute", left: `${msToPct(hoverMs)}%`,
            top: 0, bottom: 0, width: 1,
            background: "rgba(255,255,255,0.3)", pointerEvents: "none",
          }}>
            <div style={{
              position: "absolute", bottom: -20, left: 0, transform: "translateX(-50%)",
              fontSize: "0.68rem", color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
            }}>{fmt(hoverMs)}</div>
          </div>
        )}
      </div>

      <div style={{
        display: "flex", justifyContent: "space-between",
        marginTop: 20, fontSize: "0.75rem", color: "var(--text-muted)",
        fontVariantNumeric: "tabular-nums",
      }}>
        <span>0:00</span>
        <span>plays {fmt(playable)} of {fmt(trackDurationMs)} · {edit.skipRegions.length} skip · {notes.length} note</span>
        <span>{fmt(trackDurationMs)}</span>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "center", fontSize: "0.78rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          fade in
          <input
            type="range" min={0} max={8000} step={250}
            value={edit.fadeInMs}
            onChange={(e) => onChange({ ...edit, fadeInMs: Number(e.target.value) })}
            style={{ width: 90 }}
          />
          <span style={{ minWidth: 36, color: "var(--text-muted)" }}>{(edit.fadeInMs / 1000).toFixed(1)}s</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          fade out
          <input
            type="range" min={0} max={8000} step={250}
            value={edit.fadeOutMs}
            onChange={(e) => onChange({ ...edit, fadeOutMs: Number(e.target.value) })}
            style={{ width: 90 }}
          />
          <span style={{ minWidth: 36, color: "var(--text-muted)" }}>{(edit.fadeOutMs / 1000).toFixed(1)}s</span>
        </label>
      </div>

      {selectedNote && (
        <NoteCard
          note={selectedNote}
          onChange={(patch) => updateNote(selectedNote.id, patch)}
          onRemove={() => removeNote(selectedNote.id)}
          onUploadImage={onUploadImage}
        />
      )}
    </div>
  );
}

function NoteCard({
  note, onChange, onRemove, onUploadImage,
}: {
  note: MixtapeNote;
  onChange: (patch: Partial<MixtapeNote>) => void;
  onRemove: () => void;
  onUploadImage?: (file: File) => Promise<string | null>;
}) {
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file || !onUploadImage) return;
    // Optimistic preview — show instantly via objectURL
    const objUrl = URL.createObjectURL(file);
    setLocalPreview(objUrl);
    setUploading(true);
    const url = await onUploadImage(file);
    if (url) onChange({ imageUrl: url });
    setUploading(false);
    // Keep previewing local until the <img src=uploaded> paints, then revoke
    setTimeout(() => { URL.revokeObjectURL(objUrl); setLocalPreview(null); }, 1500);
  };

  // Paste support — paste an image into the note card
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) { e.preventDefault(); void handleFile(file); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onUploadImage]);

  const displaySrc = localPreview ?? note.imageUrl;

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => {
        e.preventDefault();
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
        if (file) void handleFile(file);
      }}
      style={{
        marginTop: 12, padding: 12,
        background: "var(--card)", border: `1px solid var(--${note.color}-dim, var(--border))`,
        borderRadius: 12,
      }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          at {fmt(note.timestampMs)}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onChange({ color: c })}
              style={{
                width: 16, height: 16, borderRadius: "50%",
                background: `var(--${c})`, border: note.color === c ? "2px solid #fff" : "2px solid transparent",
                cursor: "pointer", padding: 0,
              }}
              aria-label={c}
            />
          ))}
          <button className="btn btn-ghost btn-xs" onClick={onRemove} style={{ color: "var(--rose)", marginLeft: 6 }}>×</button>
        </div>
      </div>

      <textarea
        className="input" placeholder="Write a note..."
        value={note.text} onChange={(e) => onChange({ text: e.target.value })}
        style={{ width: "100%", minHeight: 52, resize: "vertical", marginBottom: 8, fontSize: "0.85rem" }}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="input" placeholder="emoji" maxLength={2}
          value={note.emoji ?? ""} onChange={(e) => onChange({ emoji: e.target.value || null })}
          style={{ width: 64, textAlign: "center" }}
        />
        <select
          className="input" value={note.durationMs}
          onChange={(e) => onChange({ durationMs: Number(e.target.value) })}
          style={{ width: 82 }}
        >
          <option value={3000}>3s</option>
          <option value={5000}>5s</option>
          <option value={8000}>8s</option>
          <option value={12000}>12s</option>
        </select>

        {displaySrc ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}>
            <img src={displaySrc} alt=""
              style={{
                width: 40, height: 40, borderRadius: 6, objectFit: "cover",
                opacity: uploading ? 0.6 : 1,
              }} />
            {uploading && (
              <div style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "0.68rem", color: "#fff", textShadow: "0 1px 2px #000",
              }}>↑</div>
            )}
            {!uploading && (
              <button className="btn btn-ghost btn-xs" onClick={() => onChange({ imageUrl: null })}>remove</button>
            )}
          </div>
        ) : onUploadImage ? (
          <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            + image · drop · paste
            <input type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        ) : null}
      </div>
    </div>
  );
}
