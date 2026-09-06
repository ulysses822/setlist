import { useEffect, useState, type ReactElement } from "react";

// Theme selection. Three states rather than two: "system" tracks the Windows setting, and
// "dark"/"light" pin it regardless. The resolved value is stamped on <html data-theme>,
// which is what App.css keys off. Dark lives on :root there, so the very first paint is dark
// no matter what — nothing flashes white while this module works out where it stands.

export type Theme = "system" | "dark" | "light";

const KEY = "setlist.theme";
const LIGHT = "(prefers-color-scheme: light)";

export function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "system" || saved === "dark" || saved === "light") return saved;
  } catch {
    // Reading storage throws outright in some webview configurations rather than returning
    // null, and a theme preference is not worth taking the app down for.
  }
  return "system";
}

export function applyTheme(theme: Theme) {
  const resolved =
    theme === "system" ? (window.matchMedia(LIGHT).matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
}

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

const LABEL: Record<Theme, string> = {
  system: "follows Windows",
  light: "light",
  dark: "dark",
};

const IcoSystem = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v8h16V6H4z" />
  </svg>
);
const IcoLight = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
    <path d="M11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM3.5 4.9l1.4-1.4 2.1 2.1-1.4 1.4zM16.9 18.3l1.4-1.4 2.1 2.1-1.4 1.4zM4.9 20.5l-1.4-1.4 2.1-2.1 1.4 1.4zM18.3 7.1l-1.4-1.4 2.1-2.1 1.4 1.4z" />
  </svg>
);
const IcoDark = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
  </svg>
);

const ICON: Record<Theme, () => ReactElement> = {
  system: IcoSystem,
  light: IcoLight,
  dark: IcoDark,
};

/** Cycles system -> light -> dark. Shows the setting, not the resolved colour: on "system"
 *  it stays a monitor even though what you're looking at is one or the other. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Same as reading: the choice still holds for this session.
    }
    // Only worth listening while the OS is actually in charge.
    if (theme !== "system") return;
    const media = window.matchMedia(LIGHT);
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const Icon = ICON[theme];
  return (
    <button
      className="tool-btn theme-btn"
      onClick={() => setTheme(NEXT[theme])}
      title={`Theme: ${LABEL[theme]} — click for ${LABEL[NEXT[theme]]}`}
      aria-label={`Theme: ${LABEL[theme]}`}
    >
      <Icon />
    </button>
  );
}
