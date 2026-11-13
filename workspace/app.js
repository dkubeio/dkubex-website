// Workspace launcher. macOS-style side rail + iframe app host.
//
// The app list comes from apps.json, generated at container start by
// starter/render_config.py from apps.yaml (enabled apps only). App URLs are
// relative to this page (served at <prefix>/<UUID>/), so no absolute prefix/UUID
// is baked in — opening an app URL triggers the on-demand start + loading page.
//
// Apps open inside an iframe in the main "stage" instead of a new tab; each
// opened app keeps its iframe mounted (only the active one is shown) so app
// state is preserved when switching. Opened apps show up in the left rail and
// persist across reloads via localStorage.
//
// Choosing the folder an agent CLI works in belongs to the agent's own page
// (terminal/src/picker.ts), not here: the platform routes users straight to
// <prefix>/<UUID>/<app>/, so a gate in the launcher would only ever apply to
// half of them. The launcher just opens apps.
//
// To add an app: add an entry to apps.yaml and drop its logo in icons/.

const OPENED_KEY = "workspace:openedApps";
const PINNED_KEY = "workspace:pinnedApps";
const FRAME_TIMEOUT_MS = 8000;
const STATUS_POLL_MS = 5000;

const grid = document.getElementById("grid");
const dock = document.getElementById("dock");
const frames = document.getElementById("frames");
const catalog = document.getElementById("catalog");
const searchInput = document.getElementById("search");

/** @type {Map<string, {name:string, display_name:string, description:string, icon:string, icon_light?:string, icon_dark?:string}>} */
const appsByName = new Map();
/** name -> { frame: HTMLIFrameElement, tile: HTMLButtonElement, pill: HTMLElement } */
const frameEls = new Map();
/** ordered list of opened app names */
let opened = readList(OPENED_KEY);
/** ordered list of pinned app names — always shown in the rail, even unopened */
let pinned = readList(PINNED_KEY);
/** name -> supervisord statename, refreshed by the status poll */
let appStates = new Map();
let activeApp = null;

// ── persistence ────────────────────────────────────────────────────────────
function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

// ── theme ──────────────────────────────────────────────────────────────────
// currentTheme() / toggleTheme() live in theme.js, which owns the platform's
// `dkubex-ui-theme` key. Only the icon-swapping half is here, because only the
// launcher renders per-theme icon variants.

// Icon filename for the active theme, falling back to the base `icon` when the
// app ships no variant for that theme (see apps.yaml icon_light / icon_dark).
function iconSrc(app) {
  const themed = currentTheme() === "dark" ? app.icon_dark : app.icon_light;
  return "icons/" + (themed || app.icon || "default.svg");
}

// Repoint already-rendered card/tile icons after a theme change (only apps with
// a variant for the new theme actually change src).
// Listen rather than being called from the toggle: the theme can also change
// from the platform shell or another workspace tab, which reaches us as a
// `storage` event inside theme.js and never touches this module. Before this,
// a toggle from the platform left codex/copilot showing the wrong variant.
window.addEventListener("dkubex-theme", () => refreshThemedIcons());

function refreshThemedIcons() {
  for (const card of grid.children) {
    const app = appsByName.get(card.dataset.name);
    if (app) card.querySelector("img").src = iconSrc(app);
  }
  for (const tile of dock.children) {
    const app = appsByName.get(tile.dataset.name);
    if (app) tile.querySelector("img").src = iconSrc(app);
  }
}

// ── catalog ──────────────────────────────────────────────────────────────────
function renderCatalog(apps) {
  grid.textContent = "";
  for (const app of apps) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    card.dataset.name = app.name;
    // Vertical tile: icon over a centred label, matching the platform's app
    // grid. There is no room for the description at this width, so it becomes
    // the tooltip rather than being dropped — it is the only place an app's
    // one-liner from apps.yaml is surfaced to the user.
    card.innerHTML =
      '<span class="badge"><img alt="" aria-hidden="true"></span>' +
      '<span class="meta"><p class="name"></p></span>';
    card.querySelector("img").src = iconSrc(app);
    card.querySelector(".name").textContent = app.display_name;
    if (app.description) card.title = app.description;
    card.addEventListener("click", () => openApp(app.name));
    // Right-click a card to pin/unpin it to the rail without opening it.
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(app.name, e.clientX, e.clientY);
    });
    grid.appendChild(card);
  }
}

function filterCatalog(query) {
  const q = query.trim().toLowerCase();
  for (const card of grid.children) {
    const app = appsByName.get(card.dataset.name);
    const hay = (app.display_name + " " + (app.description || "")).toLowerCase();
    card.hidden = q !== "" && !hay.includes(q);
  }
}

// ── view switching ───────────────────────────────────────────────────────────
function showCatalog() {
  activeApp = null;
  frames.hidden = true;
  catalog.hidden = false;
  syncDockActive();
}

function showApp(name) {
  activeApp = name;
  catalog.hidden = true;
  frames.hidden = false;
  for (const [n, els] of frameEls) {
    els.frame.parentElement.classList.toggle("active", n === name);
  }
  syncDockActive();
}

// ── iframe host ──────────────────────────────────────────────────────────────
// Entry URL for an app. apps.json carries a per-app `url` (app-relative, e.g.
// "openclaw/?token=<uuid>"); the browser resolves it against the launcher page URL
// (<prefix>/<uuid>/). Falls back to "<name>/" for older apps.json.
function appUrl(name) {
  const app = appsByName.get(name);
  return (app && app.url) || name + "/";
}

function ensureFrame(name) {
  if (frameEls.has(name)) return frameEls.get(name);

  const app = appsByName.get(name);
  const wrap = document.createElement("div");
  wrap.className = "frame-wrap";

  const frame = document.createElement("iframe");
  frame.className = "app-frame";
  frame.src = appUrl(name);
  frame.title = app ? app.display_name : name;

  // Surface an "open in new tab" fallback if the app refuses to be embedded
  // (X-Frame-Options: DENY / CSP frame-ancestors) and never fires `load`.
  const pill = document.createElement("div");
  pill.className = "frame-pill";
  pill.hidden = true;
  pill.innerHTML =
    '<span>Not loading? This app may block embedding.</span>' +
    '<button type="button">Open in new tab</button>';
  pill.querySelector("button").addEventListener("click", () => openExternal(name));

  let loaded = false;
  const timer = window.setTimeout(() => {
    if (!loaded) pill.hidden = false;
  }, FRAME_TIMEOUT_MS);
  frame.addEventListener("load", () => {
    loaded = true;
    pill.hidden = true;
    window.clearTimeout(timer);
  });

  wrap.appendChild(frame);
  wrap.appendChild(pill);
  frames.appendChild(wrap);

  const els = { frame, wrap, pill };
  frameEls.set(name, els);
  return els;
}

function reloadApp(name) {
  const els = frameEls.get(name);
  if (!els) return;
  els.pill.hidden = true;
  // Re-assigning src forces a fresh load from the entry URL.
  els.frame.src = appUrl(name);
}

function openExternal(name) {
  window.open(appUrl(name), "_blank", "noopener");
}

function removeApp(name) {
  const els = frameEls.get(name);
  if (els) {
    els.wrap.remove();
    frameEls.delete(name);
  }
  opened = opened.filter((n) => n !== name);
  saveList(OPENED_KEY, opened);
  renderDock();
  if (activeApp === name) showCatalog();
}

// Stop the app's backend process (supervisord) via the loader control API, then
// close its tile/iframe. Apps are lazy-started, so reopening restarts it. The
// close happens even if the stop request fails, so a wedged app can be cleared.
async function stopApp(name) {
  try {
    const r = await fetch("_control/stop?app=" + encodeURIComponent(name), {
      method: "POST",
      cache: "no-store",
    });
    if (!r.ok) console.error("launcher: stop failed for", name, r.status);
  } catch (err) {
    console.error("launcher: failed to stop app", name, err);
  }
  removeApp(name);
}

// ── open / switch ────────────────────────────────────────────────────────────
// Every card and rail-tile click funnels through here: put the app on the rail
// and show its iframe, creating it on first use. An agent CLI that needs a
// folder asks for one itself, inside its own page.
function openApp(name) {
  if (!appsByName.has(name)) return;
  if (!opened.includes(name)) {
    opened.push(name);
    saveList(OPENED_KEY, opened);
    renderDock();
  }
  ensureFrame(name);
  showApp(name);
}

// ── pinning ────────────────────────────────────────────────────────────────
// Pinned apps stay in the rail even when not opened; the dock shows the union
// of pinned + opened apps (pinned first). Clicking a pinned-but-unopened tile
// lazy-starts and opens it like any card.
function pinApp(name) {
  if (!appsByName.has(name) || pinned.includes(name)) return;
  pinned.push(name);
  saveList(PINNED_KEY, pinned);
  renderDock();
}

function unpinApp(name) {
  pinned = pinned.filter((n) => n !== name);
  saveList(PINNED_KEY, pinned);
  renderDock();
}

// ── rail dock ────────────────────────────────────────────────────────────────
// Apps shown in the rail: pinned first (in pin order), then any opened apps that
// aren't pinned (in open order). Names for apps that no longer exist are skipped.
function dockList() {
  const list = [];
  for (const name of pinned) {
    if (appsByName.has(name)) list.push(name);
  }
  for (const name of opened) {
    if (appsByName.has(name) && !list.includes(name)) list.push(name);
  }
  return list;
}

function renderDock() {
  dock.textContent = "";
  for (const name of dockList()) {
    const app = appsByName.get(name);

    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "rail-tile dock-tile";
    tile.dataset.name = name;
    tile.title = app.display_name;
    tile.setAttribute("aria-label", app.display_name);
    if (pinned.includes(name)) tile.classList.add("pinned");
    const img = document.createElement("img");
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.src = iconSrc(app);
    tile.appendChild(img);

    tile.addEventListener("click", () => openApp(name));
    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(name, e.clientX, e.clientY);
    });
    dock.appendChild(tile);
  }
  syncDockActive();
  applyStatus();
}

function syncDockActive() {
  for (const tile of dock.children) {
    tile.classList.toggle("active", tile.dataset.name === activeApp);
  }
}

// ── running status ─────────────────────────────────────────────────────────
// Reflect each app's supervisord run state onto its rail tile: RUNNING tiles get
// a `.running` class that shows a green dot. Poll the loader's control API, which
// reaches the loader even while apps are up (the @loader fallback only fires on
// app-down).
function applyStatus() {
  for (const tile of dock.children) {
    tile.classList.toggle("running", appStates.get(tile.dataset.name) === "RUNNING");
  }
}

async function pollStatus() {
  try {
    const r = await fetch("_control/status", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    appStates = new Map(Object.entries(data.states || {}));
    applyStatus();
  } catch {}
}

// ── rail context menu ────────────────────────────────────────────────────────
let openMenu = null;
function closeContextMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.removeEventListener("click", closeContextMenu);
    document.removeEventListener("keydown", onMenuKey);
  }
}
function onMenuKey(e) {
  if (e.key === "Escape") closeContextMenu();
}
function openContextMenu(name, x, y) {
  closeContextMenu();
  const isOpen = frameEls.has(name);
  const isPinned = pinned.includes(name);
  const menu = document.createElement("div");
  menu.className = "context-menu menu";
  // Menu adapts to state: pin toggles always; the open-app actions (reload,
  // stop) only appear once the app has an iframe.
  const items = [
    isPinned
      ? ["Unpin", () => unpinApp(name)]
      : ["Pin", () => pinApp(name)],
  ];
  if (isOpen) items.push(["Reload", () => reloadApp(name)]);
  items.push(["Open in new tab", () => openExternal(name)]);
  if (isOpen) items.push(["Stop app", () => stopApp(name), true]);
  for (const [label, fn, danger] of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item" + (danger ? " danger" : "");
    item.textContent = label;
    item.addEventListener("click", () => {
      closeContextMenu();
      fn();
    });
    menu.appendChild(item);
  }
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
  openMenu = menu;
  // Defer so the triggering click/contextmenu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("click", closeContextMenu);
    document.addEventListener("keydown", onMenuKey);
  });
}

// ── wire up ──────────────────────────────────────────────────────────────────
// The brand is the "all apps" button — clicking it returns to the catalog.
document.getElementById("brand").addEventListener("click", showCatalog);
document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
searchInput.addEventListener("input", () => filterCatalog(searchInput.value));

fetch("apps.json", { cache: "no-store" })
  .then((r) => r.json())
  .then((apps) => {
    for (const app of apps) appsByName.set(app.name, app);
    renderCatalog(apps);
    // Drop any persisted apps that no longer exist, then restore the dock.
    opened = opened.filter((n) => appsByName.has(n));
    pinned = pinned.filter((n) => appsByName.has(n));
    saveList(OPENED_KEY, opened);
    saveList(PINNED_KEY, pinned);
    renderDock();
    showCatalog();
    // Badge running apps in the rail, then keep it fresh on an interval.
    pollStatus();
    setInterval(pollStatus, STATUS_POLL_MS);
  })
  .catch((err) => {
    grid.innerHTML =
      '<p class="load-error">Failed to load apps. Check the workspace logs.</p>';
    console.error("launcher: failed to load apps.json", err);
  });
