'use strict';

(() => {
  // ---------- Constants ----------
  const STORE_KEY = 'spinwheel:v1';
  const MAX_CHARS = 26;      // wheel labels are cut here with an ellipsis
  const MAX_LABEL = 60;      // longest label we store
  const MAX_IMPORT = 500;    // most items one CSV can add
  const PAPA_SRC = 'vendor/papaparse.min.js?v=5.7.0';

  // Hand-picked palette; repeats get a lighter/darker shift so neighbours stay distinct
  const PALETTE = ['#ff5a36', '#ffb000', '#1fb58f', '#3d5afe', '#9b5de5', '#f0508c',
                   '#00a6ed', '#7cc242', '#ff8a3d', '#5c6bc0', '#e6c229', '#12a4a4'];
  const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

  // ---------- Elements ----------
  const $ = id => document.getElementById(id);
  const el = {
    canvas: $('wheel'), wrap: $('wrap'), pointer: $('pointer'), spinBtn: $('spinBtn'),
    result: $('result'), resDot: $('resDot'), resName: $('resName'),
    resRemove: $('resRemove'), resClose: $('resClose'), countdown: $('resCountdown'),
    side: $('side'), controls: $('controls'), list: $('list'), listWrap: $('listWrap'),
    count: $('count'), addForm: $('addForm'), newItem: $('newItem'), rowTpl: $('rowTpl'),
    settings: $('settings'), spinTime: $('spinTime'), spinTimeOut: $('spinTimeOut'),
    noRemove: $('noRemove'), autoRemove: $('autoRemove'),
    autoDelay: $('autoDelay'), autoDelayOut: $('autoDelayOut'), autoDelayRow: $('autoDelayRow'),
    importBtn: $('importBtn'), csvFile: $('csvFile'), recolor: $('recolor'),
    clearAll: $('clearAll'), clearDialog: $('clearDialog'), toast: $('toast'),
    itemsToggle: $('itemsToggle'),
  };
  const ctx = el.canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- State ----------
  const state = {
    items: [],              // { label, color }
    seconds: 5,
    settings: { noRemove: false, autoRemove: false, autoDelay: 3, open: false, itemsOpen: true },
  };
  let rotation = 0;         // degrees, clockwise
  let anim = null;          // { t0, from, D, T } while spinning
  let raf = 0;
  let lastIndex = -1;
  let winner = -1;
  let pending = null;       // { item, timer } while an auto-remove counts down
  let wheelSize = 0;        // CSS px, kept current by the ResizeObserver

  // ---------- Colors ----------
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = c => Math.max(0, Math.min(255, Math.round(c + (amt > 0 ? 255 - c : c) * amt)));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function autoColor(i) {
    const base = PALETTE[i % PALETTE.length];
    const round = Math.floor(i / PALETTE.length);
    return round === 0 ? base : shade(base, round % 2 ? 0.3 : -0.25);
  }
  function nextColor() {
    const used = new Set(state.items.map(x => x.color));
    let k = state.items.length, color = autoColor(k);
    for (let t = 0; t < 48 && used.has(color); t++) color = autoColor(++k);
    return color;
  }
  function normalizeHex(v) {
    const m = String(v ?? '').trim().match(HEX);
    if (!m) return null;
    const h = m[1].toLowerCase();
    return '#' + (h.length === 3 ? [...h].map(c => c + c).join('') : h);
  }
  const textColorCache = new Map();
  function textOn(hex) {
    let v = textColorCache.get(hex);
    if (v) return v;
    const n = parseInt(hex.slice(1), 16);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    v = L > 0.36 ? '#17181c' : '#ffffff';
    textColorCache.set(hex, v);
    return v;
  }
  const cleanLabel = s => String(s ?? '').replace(/﻿/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);

  // ---------- Storage (debounced so typing doesn't hit localStorage per key) ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      if (!s) return;
      if (Array.isArray(s.items)) {
        state.items = s.items
          .filter(x => x && typeof x.label === 'string' && normalizeHex(x.color))
          .map(x => ({ label: x.label.slice(0, MAX_LABEL), color: normalizeHex(x.color) }));
      }
      state.seconds = Math.min(20, Math.max(1, +s.seconds || 5));
      const st = s.settings ?? {};
      state.settings = {
        noRemove: !!st.noRemove,
        autoRemove: !!st.autoRemove,
        autoDelay: Math.min(10, Math.max(1, +st.autoDelay || 3)),
        open: !!st.open,
        itemsOpen: st.itemsOpen !== false, // open unless someone collapsed it
      };
    } catch { /* storage blocked or corrupt: start fresh */ }
  }
  let saveTimer = 0;
  function writeNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 250);
  }
  addEventListener('pagehide', () => saveTimer && writeNow());
  document.addEventListener('visibilitychange', () => document.hidden && saveTimer && writeNow());

  // ---------- Wheel drawing ----------
  // The wheel is painted once per change, at rotation 0. Spinning only changes the
  // canvas element's CSS `rotate`, which the compositor handles without repainting.
  function fit(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text.replace(/…$/, '');
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  }

  // Cut at 26 chars, wrap on spaces, hyphen-split words that don't fit,
  // and end with "…" if it still needs more lines than the slice has room for.
  const labelCache = new Map();
  function wrapLabel(text, maxW, maxLines, font) {
    const key = `${font}|${maxW | 0}|${maxLines}|${text}`;
    const hit = labelCache.get(key);
    if (hit) return hit;

    let t = text.trim().replace(/\s+/g, ' ');
    if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS).trimEnd() + '…';
    const lines = [];
    let cur = '';
    for (let w of t.split(' ')) {
      while (ctx.measureText(w).width > maxW && w.length > 1) {
        if (cur) { lines.push(cur); cur = ''; }
        let k = w.length - 1;
        while (k > 1 && ctx.measureText(w.slice(0, k) + '-').width > maxW) k--;
        lines.push(w.slice(0, k) + '-');
        w = w.slice(k);
      }
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width <= maxW) cur = test;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);

    let out = lines;
    if (lines.length > maxLines) {
      out = lines.slice(0, maxLines);
      out[maxLines - 1] = fit(out[maxLines - 1].replace(/[-…]$/, '') + '…', maxW);
    }
    if (labelCache.size > 2000) labelCache.clear();
    labelCache.set(key, out);
    return out;
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function draw() {
    const size = wheelSize || el.wrap.clientWidth;
    if (!size) return;
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const px = Math.round(size * dpr);
    if (el.canvas.width !== px) { el.canvas.width = px; el.canvas.height = px; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    el.wrap.classList.add('drawn'); // retire the stand-in wheel from <head>

    // Theme colors come from resolved styles, since light-dark() can't go into a canvas directly
    const surface = getComputedStyle(el.spinBtn).backgroundColor;
    const ink = getComputedStyle(document.body).color;

    const c = size / 2, R = c - 2;
    const { items } = state;
    const n = items.length;

    if (!n) {
      ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fillStyle = surface; ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.setLineDash([6, 8]); ctx.lineWidth = 2; ctx.strokeStyle = ink;
      ctx.beginPath(); ctx.arc(c, c, R - 10, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `500 ${Math.max(14, size * 0.032)}px "Schibsted Grotesk", system-ui, sans-serif`;
      ctx.fillText('Add items to fill the wheel', c, c + size * 0.18);
      ctx.globalAlpha = 1;
      return;
    }

    const a = (Math.PI * 2) / n;
    const fs = Math.max(11, Math.min(size * 0.042, a * R * 0.42, 24));
    const lh = fs * 1.15;
    const maxLines = Math.max(1, Math.min(3, Math.floor((a * R * 0.6) / lh)));
    const maxW = R * 0.6;
    const font = `700 ${fs}px "Schibsted Grotesk", system-ui, sans-serif`;
    ctx.font = font;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < n; i++) {
      const start = -Math.PI / 2 + i * a;
      ctx.globalAlpha = winner > -1 && i !== winner ? 0.28 : 1;

      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, R, start, start + a);
      ctx.closePath();
      ctx.fillStyle = items[i].color;
      ctx.fill();

      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(start + a / 2);
      ctx.fillStyle = textOn(items[i].color);
      const lines = wrapLabel(items[i].label, maxW, maxLines, font);
      for (let j = 0; j < lines.length; j++) {
        ctx.fillText(lines[j], R - fs * 1.1, (j - (lines.length - 1) / 2) * lh);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (n > 1) {
      ctx.strokeStyle = surface;
      ctx.lineWidth = Math.max(2, size * 0.004);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + i * a;
        ctx.moveTo(c, c);
        ctx.lineTo(c + Math.cos(ang) * R, c + Math.sin(ang) * R);
      }
      ctx.stroke();
    }
  }

  const applyRotation = () => { el.canvas.style.rotate = `${rotation}deg`; };

  function indexAtPointer() {
    const n = state.items.length;
    if (!n) return -1;
    const p = ((-rotation % 360) + 360) % 360;
    return Math.floor(p / (360 / n)) % n;
  }

  // ---------- Spinning ----------
  // Ease-out cubic: angle = from + D(1-(1-t)^3), so the starting speed is 3D/T.
  // A tap mid-spin reads the current speed, adds a boost, and restarts the ease from there.
  function motionAt(now) {
    if (!anim) return { angle: rotation, speed: 0, done: true };
    const t = Math.min((now - anim.t0) / anim.T, 1);
    return {
      angle: anim.from + anim.D * (1 - (1 - t) ** 3),
      speed: (3 * anim.D / anim.T) * (1 - t) ** 2,
      done: t >= 1,
    };
  }

  function spin() {
    flushPending(); // an item waiting to be auto-removed goes before the next spin
    if (!state.items.length) return;

    const now = performance.now();
    const m = motionAt(now);
    rotation = m.angle;
    const v0 = Math.min(m.speed + 1 + Math.random() * 0.7, 7); // deg per ms
    const T = state.seconds * 1000;
    anim = { t0: now, from: rotation, D: (v0 * T) / 3, T };

    if (winner > -1) { winner = -1; draw(); }
    hideResult();
    el.controls.disabled = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  let tickAnim = null;
  function tick() {
    if (reducedMotion.matches) return;
    tickAnim?.cancel();
    tickAnim = el.pointer.animate(
      [{ rotate: '-18deg' }, { rotate: '0deg' }],
      { duration: 120, easing: 'ease-out' },
    );
  }

  function frame(now) {
    const m = motionAt(now);
    rotation = m.angle;
    applyRotation();

    const idx = indexAtPointer();
    if (idx !== lastIndex) { lastIndex = idx; tick(); }

    if (m.done) finish();
    else raf = requestAnimationFrame(frame);
  }

  function finish() {
    anim = null;
    rotation = ((rotation % 360) + 360) % 360;
    applyRotation();
    el.controls.disabled = false;

    winner = indexAtPointer();
    const item = state.items[winner];
    if (!item) return;
    draw();

    const { noRemove, autoRemove, autoDelay } = state.settings;
    el.resDot.style.background = item.color;
    el.resName.textContent = item.label;
    el.resRemove.hidden = noRemove || autoRemove;
    el.result.hidden = false;

    el.countdown.classList.remove('run');
    if (autoRemove) {
      el.countdown.style.setProperty('--delay', `${autoDelay}s`);
      void el.countdown.offsetWidth; // restart the drain animation
      el.countdown.classList.add('run');
      pending = { item, timer: setTimeout(flushPending, autoDelay * 1000) };
    }
  }

  function flushPending() {
    if (!pending) return;
    const { item, timer } = pending;
    pending = null;
    clearTimeout(timer);
    removeItem(state.items.indexOf(item));
  }

  function hideResult() {
    if (pending) { flushPending(); return; }
    el.result.hidden = true;
    el.countdown.classList.remove('run');
    if (winner > -1) { winner = -1; requestDraw(); }
  }

  // Back to the start: pointer in the middle of the first item, nothing highlighted
  function resetWheel() {
    if (pending) { clearTimeout(pending.timer); pending = null; }
    el.countdown.classList.remove('run');
    el.result.hidden = true;
    const n = state.items.length;
    rotation = n ? -(360 / n) / 2 : 0;
    winner = -1;
    lastIndex = indexAtPointer();
    applyRotation();
    requestDraw();
  }

  // ---------- Items list ----------
  function render() {
    const { items } = state;
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const row = el.rowTpl.content.firstElementChild.cloneNode(true);
      row.dataset.index = i;
      const [color, label, remove] = row.children;
      color.value = item.color;
      color.ariaLabel = `Color for ${item.label || 'item'}`;
      label.value = item.label;
      label.ariaLabel = `Item ${i + 1}`;
      remove.ariaLabel = `Remove ${item.label || 'item'}`;
      frag.append(row);
    });
    el.list.replaceChildren(frag);
    el.count.textContent = items.length === 1 ? '1 item' : `${items.length} items`;
    el.spinBtn.disabled = !items.length;
  }

  function commit() {
    save();
    render();
    resetWheel();
  }

  function removeItem(i) {
    if (i < 0 || i >= state.items.length) return;
    state.items.splice(i, 1);
    commit();
  }

  const rowIndex = target => {
    const row = target.closest('.row');
    return row ? +row.dataset.index : -1;
  };

  // One set of listeners for every row (event delegation)
  el.list.addEventListener('input', e => {
    const i = rowIndex(e.target);
    const item = state.items[i];
    if (!item) return;
    if (e.target.dataset.field === 'color') {
      item.color = e.target.value;
    } else {
      item.label = e.target.value;
      e.target.nextElementSibling.ariaLabel = `Remove ${item.label || 'item'}`;
    }
    save();
    resetWheel();
  });
  el.list.addEventListener('focusout', e => {
    if (e.target.dataset.field !== 'label' || e.target.value.trim()) return;
    removeItem(rowIndex(e.target));
  });
  el.list.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.dataset.field === 'label') {
      e.preventDefault();
      el.newItem.focus();
    }
  });
  el.list.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="remove"]');
    if (btn) removeItem(rowIndex(btn));
  });

  el.addForm.addEventListener('submit', e => {
    e.preventDefault();
    const label = cleanLabel(el.newItem.value);
    if (!label) return;
    state.items.push({ label, color: nextColor() });
    el.newItem.value = '';
    commit();
    el.newItem.focus();
    el.listWrap.scrollTop = el.listWrap.scrollHeight;
  });

  el.recolor.addEventListener('click', () => {
    state.items.forEach((it, i) => { it.color = autoColor(i); });
    commit();
  });

  el.clearAll.addEventListener('click', () => {
    if (!state.items.length) return;
    el.clearDialog.returnValue = '';
    el.clearDialog.showModal();
  });
  el.clearDialog.addEventListener('close', () => {
    if (el.clearDialog.returnValue !== 'clear') return;
    state.items = [];
    commit();
  });

  // ---------- Result bar ----------
  el.resRemove.addEventListener('click', () => {
    if (state.settings.noRemove || winner < 0) return;
    removeItem(winner);
  });
  el.resClose.addEventListener('click', hideResult);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el.clearDialog.open) hideResult();
  });

  el.canvas.addEventListener('click', spin);
  el.spinBtn.addEventListener('click', spin);

  // ---------- Settings ----------
  const fillRange = r => r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);

  function syncSettings() {
    const s = state.settings;
    el.spinTime.value = state.seconds;
    el.spinTimeOut.value = `${state.seconds}s`;
    fillRange(el.spinTime);
    el.noRemove.checked = s.noRemove;
    el.autoRemove.checked = s.autoRemove;
    el.autoDelay.value = s.autoDelay;
    el.autoDelayOut.value = `${s.autoDelay}s`;
    fillRange(el.autoDelay);
    el.autoDelayRow.hidden = !s.autoRemove;
    el.settings.open = s.open;
    setItemsOpen(s.itemsOpen);
  }

  el.spinTime.addEventListener('input', () => {
    state.seconds = +el.spinTime.value;
    el.spinTimeOut.value = `${state.seconds}s`;
    fillRange(el.spinTime);
    save();
  });
  el.noRemove.addEventListener('change', () => {
    state.settings.noRemove = el.noRemove.checked;
    if (state.settings.noRemove) el.resRemove.hidden = true;
    save();
  });
  el.autoRemove.addEventListener('change', () => {
    state.settings.autoRemove = el.autoRemove.checked;
    el.autoDelayRow.hidden = !state.settings.autoRemove;
    save();
  });
  el.autoDelay.addEventListener('input', () => {
    state.settings.autoDelay = +el.autoDelay.value;
    el.autoDelayOut.value = `${state.settings.autoDelay}s`;
    fillRange(el.autoDelay);
    save();
  });
  el.settings.addEventListener('toggle', () => {
    state.settings.open = el.settings.open;
    save();
  });

  // ---------- Collapsible item list ----------
  function setItemsOpen(open) {
    state.settings.itemsOpen = open;
    el.itemsToggle.setAttribute('aria-expanded', String(open));
    el.listWrap.hidden = !open;
  }
  el.itemsToggle.addEventListener('click', () => {
    setItemsOpen(!state.settings.itemsOpen);
    save();
  });

  // ---------- Toast ----------
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000);
  }

  // ---------- CSV import (Papa Parse loads only when first needed) ----------
  let papaPromise = null;
  function loadPapa() {
    if (window.Papa) return Promise.resolve(window.Papa);
    return (papaPromise ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PAPA_SRC;
      s.async = true;
      s.onload = () => resolve(window.Papa);
      s.onerror = () => { papaPromise = null; s.remove(); reject(new Error('parser')); };
      document.head.append(s);
    }));
  }

  const NAME_HEADER = /^(items?|names?|labels?|entr(y|ies)|options?|choices?|values?)$/i;
  const COLOR_HEADER = /^colou?rs?$/i;

  // Accepts: a header row with an item/name column (plus an optional color column),
  // one item per line, "label,#hex" pairs, or several items on one line.
  function extractItems(rows) {
    const cells = rows.map(r => r.map(cleanLabel));
    const out = [];
    const nameCol = cells[0]?.findIndex(c => NAME_HEADER.test(c)) ?? -1;

    if (nameCol > -1) {
      const colorCol = cells[0].findIndex(c => COLOR_HEADER.test(c));
      for (const row of cells.slice(1)) {
        const label = row[nameCol];
        if (label) out.push({ label, color: colorCol > -1 ? normalizeHex(row[colorCol]) : null });
      }
      return out;
    }

    for (const row of cells) {
      const filled = row.filter(Boolean);
      if (filled.length === 2 && normalizeHex(filled[1]) && !normalizeHex(filled[0])) {
        out.push({ label: filled[0], color: normalizeHex(filled[1]) });
      } else {
        for (const label of filled) out.push({ label, color: null });
      }
    }
    return out;
  }

  async function importFile(file) {
    if (!file) return;
    if (anim) { toast('Wait for the wheel to stop, then import.'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('That file is too large (5 MB max).'); return; }

    let Papa;
    try { Papa = await loadPapa(); }
    catch { toast('Couldn’t load the CSV reader. Try again.'); return; }

    const rows = await new Promise(resolve => {
      Papa.parse(file, {
        skipEmptyLines: 'greedy',
        complete: r => resolve(r.data),
        error: () => resolve(null),
      });
    });
    if (!rows) { toast('Couldn’t read that file.'); return; }

    const found = extractItems(rows);
    if (!found.length) { toast('No items found in that file.'); return; }

    const added = found.slice(0, MAX_IMPORT);
    for (const it of added) state.items.push({ label: it.label, color: it.color ?? nextColor() });
    commit();
    if (!state.settings.itemsOpen) setItemsOpen(true); // show what was just added
    el.listWrap.scrollTop = el.listWrap.scrollHeight;

    const noun = added.length === 1 ? 'item' : 'items';
    toast(found.length > MAX_IMPORT
      ? `Added the first ${MAX_IMPORT} of ${found.length} items.`
      : `Added ${added.length} ${noun} from ${file.name}.`);
  }

  // Start fetching the parser as soon as someone heads for the button
  const warmPapa = () => { loadPapa().catch(() => {}); };
  el.importBtn.addEventListener('pointerenter', warmPapa, { once: true });
  el.importBtn.addEventListener('focus', warmPapa, { once: true });
  el.importBtn.addEventListener('click', () => el.csvFile.click());
  el.csvFile.addEventListener('change', () => {
    importFile(el.csvFile.files[0]);
    el.csvFile.value = '';
  });

  // Drag a CSV onto the item panel
  const hasFiles = e => e.dataTransfer?.types.includes('Files');
  el.side.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.side.classList.add('dragging');
    warmPapa();
  });
  el.side.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.side.addEventListener('dragleave', e => {
    if (!el.side.contains(e.relatedTarget)) el.side.classList.remove('dragging');
  });
  el.side.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.side.classList.remove('dragging');
    importFile(e.dataTransfer.files[0]);
  });
  // Don't let a file dropped elsewhere replace the page
  addEventListener('dragover', e => hasFiles(e) && e.preventDefault());
  addEventListener('drop', e => hasFiles(e) && e.preventDefault());

  // ---------- Init ----------
  load();
  syncSettings();
  render();
  resetWheel();
  draw(); // now, not next frame, so the first paint already has the real wheel

  // Transitions stay off until the restored state has painted (see styles.css)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.add('ready');
  }));

  new ResizeObserver(([entry]) => {
    const size = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    if (size === wheelSize) return;
    wheelSize = size;
    labelCache.clear();
    draw();
  }).observe(el.wrap);

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestDraw);
  document.fonts?.ready.then(() => { labelCache.clear(); requestDraw(); });

  // Offline + long-term caching. Only the built site has a working sw.js,
  // so skip it for local files and when running the unbuilt source.
  const isBuilt = !!document.querySelector('script[src*="script."][src$=".js"]:not([src="script.js"])');
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && isBuilt) {
    addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* caching is optional */ });
    }, { once: true });
  }
})();
