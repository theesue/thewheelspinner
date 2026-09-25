'use strict';

(() => {
  // ---------- Constants ----------
  const STORE_KEY = 'spinwheel:v1';
  const MAX_CHARS = 26;      // wheel labels are cut here with an ellipsis
  const MAX_LABEL = 60;      // longest label we store
  const MAX_IMPORT = 1000;   // most items one CSV can add
  const BIG_CSV = 100;       // more lines than this gets a readability heads-up
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
    itemsToggle: $('itemsToggle'), lockBtn: $('lockBtn'), repoLink: $('repoLink'),
    pinDialog: $('pinDialog'), pinForm: $('pinForm'), pinTitle: $('pinTitle'), pinText: $('pinText'),
    pinInput: $('pinInput'), pinError: $('pinError'), pinCancel: $('pinCancel'), pinSubmit: $('pinSubmit'),
    pinReveal: $('pinReveal'),
    reelWrap: $('reelWrap'), reelFrame: $('reelFrame'), reel: $('reel'), reelCaption: $('reelCaption'),
    reelSpin: $('reelSpin'), reelArrowL: $('reelArrowL'), reelArrowR: $('reelArrowR'),
    slotAt: $('slotAt'), slotAtOut: $('slotAtOut'), slotAtRow: $('slotAtRow'),
    viewRadios: document.querySelectorAll('input[name="view"]'),
  };
  const ctx = el.canvas.getContext('2d');
  const rctx = el.reel.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- State ----------
  const state = {
    items: [],              // { label, color }
    seconds: 5,
    settings: { noRemove: false, autoRemove: false, autoDelay: 3, open: false, itemsOpen: true, view: 'auto', slotAt: 100 },
    lock: null,             // { salt, hash, iter, fails, until } while locked; never the PIN itself
  };
  let rotation = 0;         // degrees, clockwise
  let anim = null;          // { t0, from, D, T } while spinning
  let raf = 0;
  let lastIndex = -1;
  let winner = -1;
  let pending = null;       // { item, timer } while an auto-remove counts down
  let wheelSize = 0;        // CSS px, kept current by the ResizeObserver
  let view = 'wheel';       // what's showing: 'wheel' or 'slot' (Auto resolves to one of these)
  let reelPos = 0;          // slot view: which row is centered, in rows (fractional while moving)
  let reelSize = { w: 0, h: 0 };

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
        view: ['auto', 'wheel', 'slot'].includes(st.view) ? st.view : 'auto',
        slotAt: Math.min(500, Math.max(20, Math.round((+st.slotAt || 100) / 10) * 10)),
      };
      const lk = s.lock;
      if (lk && typeof lk.salt === 'string' && typeof lk.hash === 'string' && lk.iter > 0) {
        state.lock = { salt: lk.salt, hash: lk.hash, iter: lk.iter | 0, fails: lk.fails | 0, until: +lk.until || 0 };
      }
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
  function fit(text, max, c = ctx) {
    if (c.measureText(text).width <= max) return text;
    let t = text.replace(/…$/, '');
    while (t.length > 1 && c.measureText(t + '…').width > max) t = t.slice(0, -1);
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
    requestAnimationFrame(() => { drawQueued = false; redraw(); });
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

  // ---------- Slot reel drawing ----------
  // Five rows fit in the frame and the middle one is the pick. The reel is redrawn
  // every frame while it moves, but only the ~7 rows in sight, so list size doesn't matter.
  const mod = (a, n) => ((a % n) + n) % n;

  function drawReel(speed = 0) {
    const { w, h } = reelSize.w ? reelSize : { w: el.reelFrame.clientWidth, h: el.reelFrame.clientHeight };
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (el.reel.width !== pw || el.reel.height !== ph) { el.reel.width = pw; el.reel.height = ph; }
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.clearRect(0, 0, w, h);

    const { items } = state;
    const n = items.length;
    rctx.textAlign = 'center';
    rctx.textBaseline = 'middle';

    if (!n) {
      rctx.fillStyle = getComputedStyle(document.body).color;
      rctx.globalAlpha = 0.6;
      rctx.font = `500 ${Math.max(14, w * 0.032)}px "Schibsted Grotesk", system-ui, sans-serif`;
      rctx.fillText('Add items to fill the reel', w / 2, h / 2);
      rctx.globalAlpha = 1;
      return;
    }

    const rowH = h / 5, mid = h / 2, padX = 10, gap = 4;
    const fs = Math.max(14, Math.min(22, rowH * 0.34));
    rctx.font = `700 ${fs}px "Schibsted Grotesk", system-ui, sans-serif`;
    // Past a couple of rows per frame the names can't be read anyway, so fade them
    // and let the colors streak by
    const labelAlpha = Math.max(0, Math.min(1, 1 - (speed - 0.012) / 0.03));

    for (let k = Math.floor(reelPos) - 3; k <= Math.ceil(reelPos) + 3; k++) {
      const i = mod(k, n);
      const item = items[i];
      const y = mid + (k - reelPos) * rowH;
      const alpha = winner > -1 && i !== winner ? 0.28 : 1;

      rctx.globalAlpha = alpha;
      rctx.fillStyle = item.color;
      rctx.beginPath();
      rctx.roundRect(padX, y - rowH / 2 + gap, w - padX * 2, rowH - gap * 2, 12);
      rctx.fill();

      if (labelAlpha > 0) {
        rctx.globalAlpha = alpha * labelAlpha;
        rctx.fillStyle = textOn(item.color);
        rctx.fillText(fit(item.label, w - 96, rctx), w / 2, y);
      }
    }
    rctx.globalAlpha = 1;
  }

  // Whichever view is showing
  function redraw(speed) {
    if (view === 'slot') drawReel(speed);
    else draw();
  }

  const applyRotation = () => { el.canvas.style.rotate = `${rotation}deg`; };

  // Position in the current view's units: degrees for the wheel, rows for the reel
  const getPos = () => (view === 'slot' ? reelPos : rotation);
  function setPos(value, speed = 0) {
    if (view === 'slot') { reelPos = value; drawReel(speed); }
    else { rotation = value; applyRotation(); }
  }

  function indexAtPointer() {
    const n = state.items.length;
    if (!n) return -1;
    if (view === 'slot') return mod(Math.round(reelPos), n);
    const p = mod(-rotation, 360);
    return Math.floor(p / (360 / n)) % n;
  }

  // Auto picks the reel once the list is longer than the chosen size
  function resolveView() {
    const { view: v, slotAt } = state.settings;
    return v === 'auto' ? (state.items.length > slotAt ? 'slot' : 'wheel') : v;
  }
  function updateView() {
    const next = resolveView();
    document.documentElement.dataset.view = next;
    if (next === view) return false;
    view = next;
    return true;
  }

  // ---------- Spinning ----------
  // Ease-out cubic: angle = from + D(1-(1-t)^3), so the starting speed is 3D/T.
  // A tap mid-spin reads the current speed, adds a boost, and restarts the ease from there.
  function motionAt(now) {
    if (!anim) return { angle: getPos(), speed: 0, done: true };
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
    setPos(m.angle);
    // Reduced motion: keep it short
    const T = (reducedMotion.matches ? Math.min(state.seconds, 1.5) : state.seconds) * 1000;

    // How far to travel. The random part spans exactly one full turn (or one pass
    // through the list), so every item is equally likely. `carry` keeps momentum
    // from a spin that's already going, so tapping again speeds it up.
    const carry = m.speed * T / 3;
    let D;
    if (view === 'slot') {
      const n = state.items.length;
      D = Math.min(carry, 4 * n + 120) + 30 + Math.random() * n;
      D = Math.round(m.angle + D) - m.angle; // stop dead-center on a row
    } else {
      const base = 1.25 * T / 3;              // about 1.25°/ms at the start
      const cap = Math.max(0, 7 * T / 3 - base - 360); // top speed stays under 7°/ms
      D = Math.min(carry, cap) + base + Math.random() * 360;
    }
    anim = { t0: now, from: m.angle, D, T };

    if (winner > -1) { winner = -1; redraw(); }
    hideResult();
    setControlsState();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  // Pointer flick each time an item passes. Throttled, since the reel can pass
  // dozens of rows a second and that would just be a buzz.
  let tickAnims = [];
  let lastTick = 0;
  function tick(now) {
    if (reducedMotion.matches || now - lastTick < 45) return;
    lastTick = now;
    tickAnims.forEach(a => a.cancel());
    const opts = { duration: 120, easing: 'ease-out' };
    tickAnims = view === 'slot'
      ? [el.reelArrowL, el.reelArrowR].map(a => a.animate([{ scale: '1.4' }, { scale: '1' }], opts))
      : [el.pointer.animate([{ rotate: '-18deg' }, { rotate: '0deg' }], opts)];
  }

  function frame(now) {
    const m = motionAt(now);
    setPos(m.angle, m.speed);

    const idx = indexAtPointer();
    if (idx !== lastIndex) { lastIndex = idx; tick(now); }

    if (m.done) finish();
    else raf = requestAnimationFrame(frame);
  }

  function finish() {
    anim = null;
    if (view === 'slot') reelPos = mod(Math.round(reelPos), state.items.length || 1);
    else { rotation = mod(rotation, 360); applyRotation(); }
    setControlsState();

    winner = indexAtPointer();
    const item = state.items[winner];
    if (!item) return;
    redraw();

    const { autoRemove, autoDelay } = state.settings;
    el.resDot.style.background = item.color;
    el.resName.textContent = item.label;
    syncRemoveButton();
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
    updateView();
    const n = state.items.length;
    rotation = n ? -(360 / n) / 2 : 0; // wheel: first slice centered under the pointer
    reelPos = 0;                        // reel: first row in the window
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
    el.spinBtn.disabled = el.reelSpin.disabled = !items.length;
    el.reelCaption.textContent = items.length > 1
      ? `Every one of the ${items.length.toLocaleString()} items has the same chance.`
      : '';
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
    if (state.settings.noRemove || state.lock || winner < 0) return;
    removeItem(winner);
  });
  el.resClose.addEventListener('click', hideResult);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el.clearDialog.open && !el.pinDialog.open) hideResult();
  });

  el.canvas.addEventListener('click', spin);
  el.spinBtn.addEventListener('click', spin);
  el.reel.addEventListener('click', spin);
  el.reelSpin.addEventListener('click', spin);

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
    el.viewRadios.forEach(r => { r.checked = r.value === s.view; });
    el.slotAt.value = s.slotAt;
    el.slotAtOut.value = `${s.slotAt} items`;
    fillRange(el.slotAt);
    el.slotAtRow.hidden = s.view !== 'auto';
  }

  // View: switching resets the wheel/reel to its start, like any other change
  function viewChanged() {
    save();
    if (resolveView() !== view) resetWheel();
  }
  el.viewRadios.forEach(r => r.addEventListener('change', () => {
    if (!r.checked) return;
    state.settings.view = r.value;
    el.slotAtRow.hidden = r.value !== 'auto';
    viewChanged();
  }));
  el.slotAt.addEventListener('input', () => {
    state.settings.slotAt = +el.slotAt.value;
    el.slotAtOut.value = `${state.settings.slotAt} items`;
    fillRange(el.slotAt);
    viewChanged();
  });

  el.spinTime.addEventListener('input', () => {
    state.seconds = +el.spinTime.value;
    el.spinTimeOut.value = `${state.seconds}s`;
    fillRange(el.spinTime);
    save();
  });
  // The picked item's Remove button shows unless either setting takes it away.
  // Runs on every change, so it comes back as soon as both are off.
  function syncRemoveButton() {
    el.resRemove.hidden = state.settings.noRemove || state.settings.autoRemove || !!state.lock;
  }

  el.noRemove.addEventListener('change', () => {
    state.settings.noRemove = el.noRemove.checked;
    syncRemoveButton();
    save();
  });
  el.autoRemove.addEventListener('change', () => {
    state.settings.autoRemove = el.autoRemove.checked;
    el.autoDelayRow.hidden = !state.settings.autoRemove;
    // Turned off during a countdown: keep the picked item on the wheel
    if (!state.settings.autoRemove && pending) {
      clearTimeout(pending.timer);
      pending = null;
      el.countdown.classList.remove('run');
    }
    syncRemoveButton();
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
  function toast(msg, ms = 3000) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
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
    if (state.lock) { toast('The wheel is locked. Unlock it to import.'); return; }
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

    // One at a time, so nextColor() sees the ones just added and colors don't repeat
    const added = found.slice(0, MAX_IMPORT);
    for (const it of added) state.items.push({ label: it.label, color: it.color ?? nextColor() });
    commit();
    if (!state.settings.itemsOpen) setItemsOpen(true); // show what was just added
    el.listWrap.scrollTop = el.listWrap.scrollHeight;

    const noun = added.length === 1 ? 'item' : 'items';
    let msg = found.length > MAX_IMPORT
      ? `Added the first ${MAX_IMPORT.toLocaleString()} of ${found.length.toLocaleString()} items.`
      : `Added ${added.length.toLocaleString()} ${noun} from ${file.name}.`;
    const big = rows.length > BIG_CSV;
    if (big) msg += ` That's over ${BIG_CSV} lines, so the labels on the wheel will be small.`;
    toast(msg, big ? 7000 : 3000);
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
    if (!hasFiles(e) || state.lock) return;
    e.preventDefault();
    el.side.classList.add('dragging');
    warmPapa();
  });
  el.side.addEventListener('dragover', e => {
    if (!hasFiles(e) || state.lock) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.side.addEventListener('dragleave', e => {
    if (!el.side.contains(e.relatedTarget)) el.side.classList.remove('dragging');
  });
  el.side.addEventListener('drop', e => {
    if (!hasFiles(e) || state.lock) return;
    e.preventDefault();
    el.side.classList.remove('dragging');
    importFile(e.dataTransfer.files[0]);
  });
  // Don't let a file dropped elsewhere replace the page
  addEventListener('dragover', e => hasFiles(e) && e.preventDefault());
  addEventListener('drop', e => hasFiles(e) && e.preventDefault());

  // ---------- What can be used right now ----------
  // Controls are off while spinning or locked. The GitHub link only goes inert
  // mid-spin; the lock button stays reachable so the wheel can be unlocked.
  function setControlsState() {
    const spinning = !!anim;
    el.controls.disabled = spinning || !!state.lock;
    el.side.classList.toggle('spinning', spinning);
    el.repoLink.inert = spinning;
    el.lockBtn.disabled = spinning;
  }

  // ---------- PIN lock ----------
  // The PIN never touches storage. It's stretched with PBKDF2 (SHA-256) and a random
  // salt, and only that hash is kept. A 4-digit PIN has 10,000 combinations, so treat
  // this as a guard against casual tampering on a shared screen, not real security.
  const PIN_ITER = 150_000;
  const MAX_TRIES = 5;
  const COOLDOWN_MS = 30_000;
  const canLock = !!globalThis.crypto?.subtle;

  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

  async function hashPin(pin, salt, iter) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
    return new Uint8Array(bits);
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  function applyLock() {
    const locked = !!state.lock;
    el.side.classList.toggle('locked', locked);
    const label = locked ? 'Unlock with your PIN' : 'Lock with a PIN';
    el.lockBtn.setAttribute('aria-label', label);
    el.lockBtn.title = label;
    el.lockBtn.setAttribute('aria-pressed', String(locked));
    el.lockBtn.hidden = !canLock && !locked;
    setControlsState();
    syncRemoveButton();
  }

  // Dialog steps: 'set' -> 'confirm' when locking, 'unlock' when unlocking
  let pinStep = 'set';
  let firstPin = '';

  const PIN_COPY = {
    set:     ['Lock the wheel', 'Choose a 4-digit PIN. You’ll need it to change anything again. Spinning still works.', 'Next'],
    confirm: ['Confirm your PIN', 'Enter the same 4 digits again.', 'Lock'],
    unlock:  ['Unlock the wheel', 'Enter your 4-digit PIN.', 'Unlock'],
  };

  function showPinStep(step, error = '') {
    pinStep = step;
    const [title, text, action] = PIN_COPY[step];
    el.pinTitle.textContent = title;
    el.pinText.textContent = text;
    el.pinSubmit.textContent = action;
    el.pinError.textContent = error;
    el.pinInput.value = '';
    el.pinInput.focus();
  }

  function cooldownLeft() {
    return state.lock ? Math.max(0, Math.ceil((state.lock.until - Date.now()) / 1000)) : 0;
  }

  el.lockBtn.addEventListener('click', () => {
    if (anim) return;
    if (!state.lock && !canLock) { toast('Locking needs a secure (https) page.'); return; }
    firstPin = '';
    el.pinSubmit.disabled = false;
    setPinRevealed(false);
    el.pinDialog.showModal();
    showPinStep(state.lock ? 'unlock' : 'set');
    const wait = cooldownLeft();
    if (wait) el.pinError.textContent = `Too many wrong tries. Try again in ${wait} seconds.`;
  });

  // Show/hide the digits. Starts hidden every time the dialog opens.
  function setPinRevealed(on) {
    el.pinInput.classList.toggle('revealed', on);
    el.pinReveal.setAttribute('aria-pressed', String(on));
    const label = on ? 'Hide PIN' : 'Show PIN';
    el.pinReveal.setAttribute('aria-label', label);
    el.pinReveal.title = label;
  }
  el.pinReveal.addEventListener('click', () => {
    setPinRevealed(!el.pinInput.classList.contains('revealed'));
    el.pinInput.focus(); // keep typing (and keep the phone keyboard up)
  });

  el.pinCancel.addEventListener('click', () => el.pinDialog.close());
  el.pinDialog.addEventListener('close', () => {
    firstPin = '';
    el.pinInput.value = '';
    el.pinError.textContent = '';
    setPinRevealed(false);
  });

  // Digits only; nothing is submitted until Enter or the button
  el.pinInput.addEventListener('input', () => {
    const digits = el.pinInput.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== el.pinInput.value) el.pinInput.value = digits;
  });

  el.pinForm.addEventListener('submit', async e => {
    e.preventDefault();
    const pin = el.pinInput.value;
    if (!/^\d{4}$/.test(pin)) { el.pinError.textContent = 'Enter 4 digits.'; el.pinInput.focus(); return; }

    if (pinStep === 'set') {
      firstPin = pin;
      showPinStep('confirm');
      return;
    }

    el.pinSubmit.disabled = true;
    try {
      if (pinStep === 'confirm') {
        if (pin !== firstPin) { firstPin = ''; showPinStep('set', 'Those PINs didn’t match. Start again.'); return; }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const hash = await hashPin(pin, salt, PIN_ITER);
        state.lock = { salt: b64(salt), hash: b64(hash), iter: PIN_ITER, fails: 0, until: 0 };
        firstPin = '';
        writeNow();
        el.pinDialog.close();
        hideResult();
        applyLock();
        toast('Locked. People can spin, but nothing can be changed.');
        return;
      }

      // Unlock
      const wait = cooldownLeft();
      if (wait) { showPinStep('unlock', `Too many wrong tries. Try again in ${wait} seconds.`); return; }
      const lock = state.lock;
      const hash = await hashPin(pin, unb64(lock.salt), lock.iter);
      if (sameBytes(hash, unb64(lock.hash))) {
        state.lock = null;
        writeNow();
        el.pinDialog.close();
        applyLock();
        toast('Unlocked.');
        return;
      }
      lock.fails += 1;
      let msg;
      if (lock.fails >= MAX_TRIES) {
        lock.fails = 0;
        lock.until = Date.now() + COOLDOWN_MS;
        msg = `Too many wrong tries. Try again in ${COOLDOWN_MS / 1000} seconds.`;
      } else {
        const left = MAX_TRIES - lock.fails;
        msg = `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
      }
      writeNow();
      showPinStep('unlock', msg);
    } finally {
      el.pinSubmit.disabled = false;
    }
  });

  // ---------- Init ----------
  load();
  syncSettings();
  render();
  resetWheel();
  applyLock();
  redraw(); // now, not next frame, so the first paint already has the real wheel/reel

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

  new ResizeObserver(([entry]) => {
    const box = entry.contentBoxSize?.[0];
    const w = box?.inlineSize ?? entry.contentRect.width;
    const h = box?.blockSize ?? entry.contentRect.height;
    if (w === reelSize.w && h === reelSize.h) return;
    reelSize = { w, h };
    if (view === 'slot') drawReel();
  }).observe(el.reelFrame);

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
