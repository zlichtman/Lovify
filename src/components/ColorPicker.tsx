const COLORS = ["rose", "violet", "amber", "emerald", "sky"] as const;
const THEME_COLORS = [...COLORS, "slate"] as const;
type Color = (typeof COLORS)[number];
type ThemeColor = (typeof THEME_COLORS)[number];

type Props = {
  selected: string;
  onChange: (c: string) => void;
  includeSlate?: boolean;
};

const HEX: Record<string, string> = {
  rose: "#e8457c", violet: "#9c5bd2", amber: "#e8a034",
  emerald: "#3dba8a", sky: "#4ca4e8", slate: "#8c8ea0",
};

export function ColorPicker({ selected, onChange, includeSlate }: Props) {
  const colors = includeSlate ? THEME_COLORS : COLORS;
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          style={{
            width: 24, height: 24, borderRadius: "50%",
            background: HEX[c], border: selected === c ? "2px solid #fff" : "2px solid transparent",
            cursor: "pointer", transition: "transform 0.15s",
            transform: selected === c ? "scale(1.15)" : "scale(1)",
          }}
        />
      ))}
    </div>
  );
}

export { COLORS, THEME_COLORS, HEX };
export type { Color, ThemeColor };
