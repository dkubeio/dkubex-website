/*
 * Theme runtime — the DKubeX platform's, not ours.
 *
 * The platform stores the user's preference in localStorage under
 * `dkubex-ui-theme` as a RAW, UNQUOTED string: "dark" | "light" | "system",
 * defaulting to dark when the key is absent, and applies the resolved value as
 * a CLASS on <html>. That contract is published for embedded apps at
 * dkubex/backend/app/skills/package-app/references/theming.md, and the workspace
 * is one — the launcher, its app iframes and the platform shell are all
 * same-origin (WORKSPACE_PUBLIC_PREFIX matches the platform's Gateway route),
 * so they genuinely share one localStorage.
 *
 * "Never create your own theme key" is the contract's rule, and we honour it —
 * this file both reads AND writes `dkubex-ui-theme`. Writing is the deliberate
 * part: the same image also runs under a plain `docker run` with no platform
 * shell anywhere, and without a writer that workspace would be stuck on the
 * dark default forever. Inside the platform the write is harmless because it is
 * the same key the shell reads, so the two stay in sync by construction.
 *
 * What we do NOT do is mirror to the platform's legacy fan-out keys
 * (`vite-ui-theme`, `headlampThemePreference`, `hdx-user-preferences`, …). Those
 * are the shell's compatibility shims for OTHER embedded apps; writing them from
 * in here could desync an app we know nothing about. One-way asymmetry, on purpose.
 *
 * The pre-paint half of this lives inline in each page's <head> (see
 * index.html) — it has to run before the first byte of CSS is applied, and a
 * <script src> would race. This file is the live half.
 */

const THEME_KEY = "dkubex-ui-theme";
const DEFAULT_THEME = "dark";
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function storedTheme() {
  // localStorage throws, not returns null, in a browser set to block site data.
  try { return localStorage.getItem(THEME_KEY) || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

function resolveTheme(value) {
  if (value === "system") return prefersDark.matches ? "dark" : "light";
  return value === "light" ? "light" : "dark";
}

/** The theme actually on screen: "light" | "dark" (never "system"). */
function currentTheme() {
  return resolveTheme(storedTheme());
}

function applyTheme(value) {
  const resolved = resolveTheme(value);
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  // Anything that has to re-render rather than merely re-cascade — the themed
  // app icons in app.js — listens for this. A plain CSS token swap needs nothing.
  window.dispatchEvent(new CustomEvent("dkubex-theme", { detail: resolved }));
  return resolved;
}

function setTheme(value) {
  try { localStorage.setItem(THEME_KEY, value); } catch {}
  // A `storage` event is dispatched to every OTHER same-origin Document, never
  // to the one that performed the write. So this call is not redundant with the
  // listener below: it is the only thing that themes the page you clicked on.
  return applyTheme(value);
}

/**
 * Flip light <-> dark, resolving "system" first.
 *
 * A user on "system" who clicks a two-state control leaves system mode with an
 * explicit choice — the only sane reading of a switch, and it cannot surprise
 * them because the pixel they clicked visibly flipped. This is exactly what the
 * platform's own binary rail toggle does (Shell/AppRail.tsx).
 *
 * Note this writes a preference the whole platform shell shares, not a
 * workspace-local one. That is intended: one toggle, one theme, everywhere.
 */
function toggleTheme() {
  return setTheme(currentTheme() === "light" ? "dark" : "light");
}

// The platform shell (or another workspace tab) changed the theme.
window.addEventListener("storage", (e) => {
  if (e.key === THEME_KEY) applyTheme(e.newValue || DEFAULT_THEME);
});

// The OS changed appearance and we are following it.
prefersDark.addEventListener("change", () => {
  if (storedTheme() === "system") applyTheme("system");
});

// One-time cleanup of the workspace's old private key. Deliberately dropped
// rather than migrated: carrying it over would push a stale workspace-local
// preference into a key that governs the entire platform UI. Both defaults were
// dark, so at worst a user who had explicitly chosen light picks it again once.
try { localStorage.removeItem("workspace:theme"); } catch {}
