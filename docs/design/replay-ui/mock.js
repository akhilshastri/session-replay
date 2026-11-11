/*
 * mock.js — the small amount of behaviour the Session Replay design mocks need (plan 06, task U0).
 *
 * Owns: (1) the theme (System / Light / Dark, saved like Mantine does), (2) the Tabler icon sprite,
 * (3) tab switching inside a tabset, pop-ups, toggles and maximise, (4) the dashed MOCK variant pill,
 * (5) the "Fit" scale of the recorded-screen stand-in.
 * Fits in: loaded by every page in this folder with a plain <script src="mock.js"> in <head>, so the
 * theme is applied before first paint. Works from file:// — no network, no modules, no libraries.
 * Pair file: mock.css. Hooks are data-attributes:
 *   [data-scheme="auto|light|dark"]   theme menu items          [data-pop-toggle]  opens the next .pop
 *   [data-tabset] > .fl-tab[data-tab] + .fl-panel[data-panel]    [data-goto-tab="id"]  selects that tab
 *   [data-maximize]                   toggles .is-maximized      [data-toggle]  flips aria-pressed
 *   <body data-variants="id:Label;id:Label">  MOCK pill; sets body[data-variant]
 *   .stage[data-fit]                  sets --fit and [data-fit-label]
 */
(() => {
  const doc = document;
  const root = doc.documentElement;
  const KEY = 'mantine-color-scheme-value'; // the same key Mantine uses, so every mock shares the choice
  const dark = window.matchMedia('(prefers-color-scheme: dark)');

  // ── Theme ──────────────────────────────────────────────────────────────
  const stored = () => {
    try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
  };
  const applyScheme = () => {
    const v = stored();
    root.setAttribute('data-mantine-color-scheme', v === 'auto' ? (dark.matches ? 'dark' : 'light') : v);
  };
  const markThemeMenu = () => {
    const v = stored();
    doc.querySelectorAll('[data-scheme]').forEach((el) => {
      el.setAttribute('aria-checked', String(el.dataset.scheme === v));
    });
    doc.querySelectorAll('.sys-now').forEach((el) => { el.textContent = ` (${dark.matches ? 'dark' : 'light'} now)`; });
  };
  applyScheme(); // runs now, in <head>, before first paint
  dark.addEventListener('change', () => { applyScheme(); markThemeMenu(); }); // "System" follows the OS live

  // ── Icon sprite (Tabler outline set + a few filled marker glyphs). Ids are "i-<name>". ──
  const ICONS = {
  'adjustments-horizontal': '<path d="M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /> <path d="M4 6l8 0" /> <path d="M16 6l4 0" /> <path d="M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /> <path d="M4 12l2 0" /> <path d="M10 12l10 0" /> <path d="M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /> <path d="M4 18l11 0" /> <path d="M19 18l1 0" />',
  'alert-triangle': '<path d="M12 9v4" /> <path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0" /> <path d="M12 16h.01" />',
  'arrow-right': '<path d="M5 12l14 0" /> <path d="M13 18l6 -6" /> <path d="M13 6l6 6" />',
  'arrows-down-up': '<path d="M17 3l0 18" /> <path d="M10 18l-3 3l-3 -3" /> <path d="M7 21l0 -18" /> <path d="M20 6l-3 -3l-3 3" />',
  'arrows-maximize': '<path d="M16 4l4 0l0 4" /> <path d="M14 10l6 -6" /> <path d="M8 20l-4 0l0 -4" /> <path d="M4 20l6 -6" /> <path d="M16 20l4 0l0 -4" /> <path d="M14 14l6 6" /> <path d="M8 4l-4 0l0 4" /> <path d="M4 4l6 6" />',
  'arrows-minimize': '<path d="M5 9l4 0l0 -4" /> <path d="M3 3l6 6" /> <path d="M5 15l4 0l0 4" /> <path d="M3 21l6 -6" /> <path d="M19 9l-4 0l0 -4" /> <path d="M15 9l6 -6" /> <path d="M19 15l-4 0l0 4" /> <path d="M15 15l6 6" />',
  'bug': '<path d="M9 9v-1a3 3 0 0 1 6 0v1" /> <path d="M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1 -10 0v-3a6 6 0 0 1 1 -3" /> <path d="M3 13l4 0" /> <path d="M17 13l4 0" /> <path d="M12 20l0 -6" /> <path d="M4 19l3.35 -2" /> <path d="M20 19l-3.35 -2" /> <path d="M4 7l3.75 2.4" /> <path d="M20 7l-3.75 2.4" />',
  'check': '<path d="M5 12l5 5l10 -10" />',
  'chevron-down': '<path d="M6 9l6 6l6 -6" />',
  'chevron-left': '<path d="M15 6l-6 6l6 6" />',
  'chevron-right': '<path d="M9 6l6 6l-6 6" />',
  'circle-check': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /> <path d="M9 12l2 2l4 -4" />',
  'circle-x': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /> <path d="M10 10l4 4m0 -4l-4 4" />',
  'click': '<path d="M3 12l3 0" /> <path d="M12 3l0 3" /> <path d="M7.8 7.8l-2.2 -2.2" /> <path d="M16.2 7.8l2.2 -2.2" /> <path d="M7.8 16.2l-2.2 2.2" /> <path d="M12 12l9 3l-4 2l-2 4l-3 -9" />',
  'clock': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /> <path d="M12 7v5l3 3" />',
  'code': '<path d="M7 8l-4 4l4 4" /> <path d="M17 8l4 4l-4 4" /> <path d="M14 4l-4 16" />',
  'copy': '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" /> <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />',
  'cursor-text': '<path d="M10 12h4" /> <path d="M9 4a3 3 0 0 1 3 3v10a3 3 0 0 1 -3 3" /> <path d="M15 4a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3" />',
  'database': '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0" /> <path d="M4 6v6a8 3 0 0 0 16 0v-6" /> <path d="M4 12v6a8 3 0 0 0 16 0v-6" />',
  'device-desktop': '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10" /> <path d="M7 20h10" /> <path d="M9 16v4" /> <path d="M15 16v4" />',
  'device-laptop': '<path d="M3 19l18 0" /> <path d="M5 7a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v8a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1l0 -8" />',
  'eye-off': '<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" /> <path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87" /> <path d="M3 3l18 18" />',
  'f-player-pause': '<path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" /> <path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />',
  'f-player-play': '<path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" />',
  'flag': '<path d="M5 5a5 5 0 0 1 7 0a5 5 0 0 0 7 0v9a5 5 0 0 1 -7 0a5 5 0 0 0 -7 0v-9" /> <path d="M5 21v-7" />',
  'flame': '<path d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.294 -2.333 5.588c0 3.704 3.134 6.706 7 6.706c3.866 0 7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235" />',
  'hand-click': '<path d="M8 13v-8.5a1.5 1.5 0 0 1 3 0v7.5" /> <path d="M11 11.5v-2a1.5 1.5 0 0 1 3 0v2.5" /> <path d="M14 10.5a1.5 1.5 0 0 1 3 0v1.5" /> <path d="M17 11.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7l-.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47" /> <path d="M5 3l-1 -1" /> <path d="M4 7h-1" /> <path d="M14 3l1 -1" /> <path d="M15 6h1" />',
  'info-circle': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /> <path d="M12 9h.01" /> <path d="M11 12h1v4h1" />',
  'keyboard': '<path d="M2 8a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2l0 -8" /> <path d="M6 10l0 .01" /> <path d="M10 10l0 .01" /> <path d="M14 10l0 .01" /> <path d="M18 10l0 .01" /> <path d="M6 14l0 .01" /> <path d="M18 14l0 .01" /> <path d="M10 14l4 .01" />',
  'layout-board': '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" /> <path d="M4 9h8" /> <path d="M12 15h8" /> <path d="M12 4v16" />',
  'link': '<path d="M9 15l6 -6" /> <path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" /> <path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" />',
  'list-details': '<path d="M13 5h8" /> <path d="M13 9h5" /> <path d="M13 15h8" /> <path d="M13 19h5" /> <path d="M3 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /> <path d="M3 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />',
  'lock': '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6" /> <path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0" /> <path d="M8 11v-4a4 4 0 1 1 8 0v4" />',
  'm-error': '<path d="M12 2.5l10.5 19h-21z" />',
  'm-fail': '<circle cx="12" cy="12" r="11" /><path d="M8 8l8 8M16 8l-8 8" style="stroke:var(--mantine-color-body);stroke-width:3.5;fill:none" />',
  'm-note': '<path d="M12 1.5l10.5 10.5-10.5 10.5L1.5 12z" />',
  'm-report': '<path d="M4 21V3" style="stroke:currentColor;stroke-width:3;fill:none" /><path d="M5 4h15l-4 5.5 4 5.5H5z" />',
  'moon': '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008" />',
  'player-pause': '<path d="M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" /> <path d="M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" />',
  'player-play': '<path d="M7 4v16l13 -8l-13 -8" />',
  'player-skip-back': '<path d="M20 5v14l-12 -7l12 -7" /> <path d="M4 5l0 14" />',
  'player-skip-forward': '<path d="M4 5v14l12 -7l-12 -7" /> <path d="M20 5l0 14" />',
  'refresh': '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /> <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />',
  'search': '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /> <path d="M21 21l-6 -6" />',
  'stack-2': '<path d="M12 4l-8 4l8 4l8 -4l-8 -4" /> <path d="M4 12l8 4l8 -4" /> <path d="M4 16l8 4l8 -4" />',
  'sun': '<path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /> <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />',
  'sun-moon': '<path d="M9.173 14.83a4 4 0 1 1 5.657 -5.657" /> <path d="M11.294 12.707l.174 .247a7.5 7.5 0 0 0 8.845 2.492a9 9 0 0 1 -14.671 2.914" /> <path d="M3 12h1" /> <path d="M12 3v1" /> <path d="M5.6 5.6l.7 .7" /> <path d="M3 21l18 -18" />',
  'terminal-2': '<path d="M8 9l3 3l-3 3" /> <path d="M13 15l3 0" /> <path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12" />',
  'texture': '<path d="M6 3l-3 3" /> <path d="M21 18l-3 3" /> <path d="M11 3l-8 8" /> <path d="M16 3l-13 13" /> <path d="M21 3l-18 18" /> <path d="M21 8l-13 13" /> <path d="M21 13l-8 8" />',
  'x': '<path d="M18 6l-12 12" /> <path d="M6 6l12 12" />',
  'zoom-scan': '<path d="M8 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /> <path d="M16 16l-2.5 -2.5" /> <path d="M3 7v-2a2 2 0 0 1 2 -2h2" /> <path d="M3 17v2a2 2 0 0 0 2 2h2" /> <path d="M17 3h2a2 2 0 0 1 2 2v2" /> <path d="M17 21h2a2 2 0 0 0 2 -2v-2" />',
  };
  const injectSprite = () => {
    const symbols = Object.entries(ICONS)
      .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`).join('');
    doc.body.insertAdjacentHTML('afterbegin',
      `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}</svg>`);
  };

  // ── Tabs, pop-ups, toggles ───────────────────────────────────────────────
  const selectTab = (tab) => {
    const set = tab.closest('[data-tabset]');
    set.querySelectorAll('.fl-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    set.querySelectorAll('.fl-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  };
  const closePops = (except) => {
    doc.querySelectorAll('.pop').forEach((p) => { if (p !== except) p.hidden = true; });
  };
  const onClick = (e) => {
    const t = e.target;
    const tab = t.closest('.fl-tab[data-tab]');
    if (tab && !t.closest('.fl-x')) selectTab(tab);

    const go = t.closest('[data-goto-tab]');
    if (go) {
      const target = doc.querySelector(`.fl-tab[data-tab="${go.dataset.gotoTab}"]`);
      if (target) selectTab(target);
    }

    const toggle = t.closest('[data-toggle]');
    if (toggle) toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));

    const max = t.closest('[data-maximize]');
    if (max) {
      const on = max.closest('.fl-tabset').classList.toggle('is-maximized');
      max.setAttribute('aria-pressed', String(on));
    }

    const scheme = t.closest('[data-scheme]');
    if (scheme) {
      try { localStorage.setItem(KEY, scheme.dataset.scheme); } catch { /* storage blocked: the page still follows the OS */ }
      applyScheme();
      markThemeMenu();
    }

    // A click inside an open pop-up keeps it open, except on a menu item.
    const pt = t.closest('[data-pop-toggle]');
    const pop = pt && pt.parentElement.querySelector(':scope > .pop');
    const inside = t.closest('.pop');
    if (!inside || t.closest('.menu-item[role^="menuitem"]')) closePops(pop);
    if (pop) pop.hidden = !pop.hidden;
  };

  // ── Border drawer (Sessions) ─────────────────────────────────────────────
  // Clicking the strip opens or closes the drawer, like a flexlayout border tab; [Show Sessions]
  // opens it. Page CSS sets each variant's starting state; a click overrides it inline until the
  // next variant switch (resetBorders).
  const borderPanel = (border) => {
    const p = border && border.nextElementSibling;
    return p && p.classList.contains('fl-border-panel') ? p : null;
  };
  const isBorderOpen = (border) => {
    const p = borderPanel(border);
    return !!p && getComputedStyle(p).display !== 'none';
  };
  const syncBorderTab = (border) => {
    const tab = border.querySelector('.fl-border-tab');
    if (tab) tab.setAttribute('aria-selected', String(isBorderOpen(border)));
  };
  const setBorder = (border, open) => {
    const p = borderPanel(border);
    if (!p) return;
    p.style.display = open ? 'flex' : 'none';
    doc.querySelectorAll('.show-sessions').forEach((b) => { b.style.display = open ? 'none' : ''; });
    syncBorderTab(border);
  };
  const resetBorders = () => {
    doc.querySelectorAll('.fl-border-panel').forEach((p) => { p.style.display = ''; });
    doc.querySelectorAll('.show-sessions').forEach((b) => { b.style.display = ''; });
    doc.querySelectorAll('.fl-border').forEach(syncBorderTab);
  };
  const onBorderClick = (e) => {
    const tab = e.target.closest('.fl-border-tab');
    const show = e.target.closest('.show-sessions');
    const border = tab ? tab.closest('.fl-border') : show ? doc.querySelector('.fl-border') : null;
    if (border) setBorder(border, show ? true : !isBorderOpen(border));
  };

  // ── MOCK variant pill ────────────────────────────────────────────────────
  const setupVariants = () => {
    const raw = doc.body.dataset.variants;
    if (!raw) return;
    const list = raw.split(';').map((s) => {
      const i = s.indexOf(':');
      return { id: s.slice(0, i), label: s.slice(i + 1) };
    });
    const pill = doc.createElement('div');
    pill.className = 'mock-pill';
    pill.innerHTML = '<button type="button" aria-haspopup="true"></button><div class="mock-pill-list" hidden></div>';
    const btn = pill.firstChild;
    const menu = pill.lastChild;
    const select = (id) => {
      const v = list.find((x) => x.id === id) || list[0];
      doc.body.dataset.variant = v.id;
      resetBorders(); // the variant's page CSS decides the drawer again
      btn.textContent = `MOCK · ${v.label} ▾`;
      menu.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === v.id)));
      history.replaceState(null, '', `#${v.id}`); // a link like 03-replay-playing.html#hover opens that variant
    };
    list.forEach((v) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.dataset.id = v.id;
      b.textContent = v.label;
      b.addEventListener('click', () => { select(v.id); menu.hidden = true; });
      menu.appendChild(b);
    });
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    doc.addEventListener('click', () => { menu.hidden = true; });
    doc.body.appendChild(pill);
    select(location.hash.slice(1));
  };

  // ── Fit scale of the 2560x1400 recorded-screen stand-in ───────────────────
  const setupFit = () => {
    doc.querySelectorAll('.stage[data-fit]').forEach((stage) => {
      const fit = () => {
        const s = Math.min((stage.clientWidth - 24) / 2560, (stage.clientHeight - 24) / 1400);
        stage.style.setProperty('--fit', s.toFixed(4));
        doc.querySelectorAll('[data-fit-label]').forEach((el) => { el.textContent = `${Math.round(s * 100)}%`; });
      };
      new ResizeObserver(fit).observe(stage);
      fit();
    });
  };

  doc.addEventListener('DOMContentLoaded', () => {
    injectSprite();
    markThemeMenu();
    setupVariants();
    setupFit();
    doc.addEventListener('click', onClick);
    doc.addEventListener('click', onBorderClick);
    resetBorders(); // pages without variants: sync the strip's aria-selected with the drawer
    doc.addEventListener('pointerdown', (e) => { // the tabset you touch becomes the active one
      const set = e.target.closest('[data-tabset]');
      if (set) doc.querySelectorAll('[data-tabset]').forEach((s) => s.classList.toggle('is-active', s === set));
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePops();
      const tab = e.target.closest && e.target.closest('.fl-tab[data-tab]');
      if (tab && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectTab(tab); }
      const strip = e.target.closest && e.target.closest('.fl-border-tab');
      if (strip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); strip.click(); }
    });
    // "Follow the play head": show the current row in the middle of its list.
    doc.querySelectorAll('.pn-scroll').forEach((box) => {
      const cur = box.querySelector('.is-current');
      if (cur) box.scrollTop = cur.offsetTop - box.clientHeight / 2;
    });
  });
})();
