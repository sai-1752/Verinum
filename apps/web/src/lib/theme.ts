export type ThemeChoice = "system" | "light" | "dark";
const KEY = "tl.theme";

export function getTheme(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") return v; } catch { /* storage unavailable */ }
  return "system";
}
export function applyTheme(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
}
export const initTheme = () => applyTheme(getTheme());
