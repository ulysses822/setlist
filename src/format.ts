// Shared display formatting for durations.

/// "3:07" for a single track; "–" when the duration is unknown.
export function fmtDuration(ms: number | null): string {
  if (ms == null) return "–";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/// "1 hr 12 min" / "47 min" for playlist totals.
export function fmtTotal(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}
