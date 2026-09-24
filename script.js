(() => {
  const STORE_KEY = 'spinwheel:v1';
  const $ = id => document.getElementById(id);
  const canvas = $('wheel'), ctx = canvas.getContext('2d');
  const wrap = $('wrap'), pointer = $('pointer'), spinBtn = $('spinBtn');
  const listEl = $('list'), countEl = $('count'), controls = $('controls');
  const spinTime = $('spinTime'), spinTimeOut = $('spinTimeOut');
  const result = $('result');

  // Hand-picked palette; repeats get a lighter/darker shift so neighbours stay distinct
  const PALETTE = ['#ff5a36','#ffb000','#1fb58f','#3d5afe','#9b5de5','#f0508c',
                   '#00a6ed','#7cc242','#ff8a3d','#5c6bc0','#e6c229','#12a4a4'];
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = c => Math.max(0, Math.min(255, Math.round(c + (amt > 0 ? (255 - c) : c) * amt)));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function autoColor(i) {
    const base = PALETTE[i % PALETTE.length];
    const round = Math.floor(i / PALETTE.length);
    return round === 0 ? base : shade(base, round % 2 ? 0.3 : -0.25);
  }
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.36 ? '#17181c' : '#ffffff';
  }
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---------- State ----------
  let items = [], seconds = 5, rotation = 0, anim = null, raf = 0, lastIndex = -1, winner = -1;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && Array.isArray(s.items)) {
        items = s.items.filter(x => x && typeof x.label === 'string' && /^#[0-9a-f]{6}$/i.test(x.color));
        seconds = Math.min(20, Math.max(1, +s.seconds || 5));
        return;
      }
    } catch (e) {}
    items = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Riley'].map((label, i) => ({ label, color: autoColor(i) }));
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ items, seconds })); } catch (e) {} }

  // ---------- Drawing ----------
  function fit(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text.replace(/…$/, '');
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  }

  const MAX_CHARS = 26;

  // Ellipsize after 26 chars, then wrap by words (hyphen-breaking any word too wide),
  // and ellipsize the last line if it still needs more lines than the slice allows.
  function wrapLabel(text, maxW, maxLines) {
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
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width <= maxW) cur = test;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(kept[maxLines - 1].replace(/[-…]$/, '') + '…', maxW);
    return kept;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (!size) return;
    const px = Math.round(size * dpr);
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const c = size / 2, R = c - 2;
    const n = items.length;
    const surface = cssVar('--surface') || '#fff';

    if (!n) {
      ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fillStyle = surface; ctx.fill();
      ctx.setLineDash([6, 8]); ctx.lineWidth = 2; ctx.strokeStyle = cssVar('--faint');
      ctx.beginPath(); ctx.arc(c, c, R - 10, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--soft'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `500 ${Math.max(14, size * 0.032)}px "Schibsted Grotesk", system-ui, sans-serif`;
      ctx.fillText('Add entries to fill the wheel', c, c + size * 0.18);
      return;
    }

    const a = Math.PI * 2 / n;
    const rot = rotation * Math.PI / 180;
    const fs = Math.max(11, Math.min(size * 0.042, a * R * 0.42, 24));
    const lh = fs * 1.15;
    const maxLines = Math.max(1, Math.min(3, Math.floor((a * R * 0.6) / lh)));
    ctx.font = `700 ${fs}px "Schibsted Grotesk", system-ui, sans-serif`;

    for (let i = 0; i < n; i++) {
      const start = -Math.PI / 2 + rot + i * a;
      ctx.globalAlpha = winner > -1 && i !== winner ? 0.28 : 1;
      ctx.beginPath(); ctx.moveTo(c, c);
      ctx.arc(c, c, R, start, start + a); ctx.closePath();
      ctx.fillStyle = items[i].color; ctx.fill();

      ctx.save();
      ctx.translate(c, c); ctx.rotate(start + a / 2);
      ctx.fillStyle = textOn(items[i].color);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const lines = wrapLabel(items[i].label, R * 0.6, maxLines);
      lines.forEach((ln, j) => ctx.fillText(ln, R - fs * 1.1, (j - (lines.length - 1) / 2) * lh));
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (n > 1) {
      ctx.strokeStyle = surface; ctx.lineWidth = Math.max(2, size * 0.004);
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + rot + i * a;
        ctx.beginPath(); ctx.moveTo(c, c);
        ctx.lineTo(c + Math.cos(ang) * R, c + Math.sin(ang) * R); ctx.stroke();
      }
    }
  }

  function indexAtPointer() {
    const n = items.length;
    if (!n) return -1;
    const p = ((-rotation % 360) + 360) % 360;
    return Math.floor(p / (360 / n)) % n;
  }

  // ---------- Spin ----------
  // Ease-out cubic: angle = from + D(1-(1-t)^3), speed at start = 3D/T.
  // A click mid-spin reads the current speed, adds a boost, and restarts the ease from there.
  function state(now) {
    if (!anim) return { angle: rotation, speed: 0, done: true };
    const t = Math.min((now - anim.t0) / anim.T, 1);
    return { angle: anim.from + anim.D * (1 - Math.pow(1 - t, 3)),
             speed: 3 * anim.D / anim.T * Math.pow(1 - t, 2), done: t >= 1 };
  }

  function spin() {
    if (!items.length) return;
    const now = performance.now();
    const s = state(now);
    rotation = s.angle;
    const v0 = Math.min(s.speed + 1.0 + Math.random() * 0.7, 7); // deg/ms
    const T = seconds * 1000;
    anim = { t0: now, from: rotation, D: v0 * T / 3, T };
    winner = -1;
    hideResult();
    controls.disabled = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    const s = state(now);
    rotation = s.angle;
    draw();
    const idx = indexAtPointer();
    if (idx !== lastIndex) {
      lastIndex = idx;
      pointer.classList.add('tick');
      setTimeout(() => pointer.classList.remove('tick'), 40);
    }
    if (s.done) finish(); else raf = requestAnimationFrame(frame);
  }

  function finish() {
    anim = null;
    rotation = ((rotation % 360) + 360) % 360;
    controls.disabled = false;
    winner = indexAtPointer();
    draw();
    const it = items[winner];
    if (!it) return;
    $('resDot').style.background = it.color;
    $('resName').textContent = it.label;
    result.classList.add('show');
  }

  function hideResult() {
    result.classList.remove('show');
    if (winner > -1) { winner = -1; draw(); }
  }

  $('resRemove').addEventListener('click', () => {
    if (winner > -1) items.splice(winner, 1);
    winner = -1; result.classList.remove('show'); commit();
  });
  $('resClose').addEventListener('click', hideResult);

  // ---------- List ----------
  const X_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function renderList() {
    listEl.innerHTML = '';
    countEl.textContent = items.length === 1 ? '1 entry' : `${items.length} entries`;
    spinBtn.disabled = !items.length;

    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'row';

      const dot = document.createElement('input');
      dot.type = 'color'; dot.className = 'dot-input'; dot.value = item.color;
      dot.setAttribute('aria-label', `Color for ${item.label || 'entry'}`);
      dot.addEventListener('input', () => { item.color = dot.value; save(); resetWheel(); });

      const txt = document.createElement('input');
      txt.type = 'text'; txt.value = item.label; txt.maxLength = 60;
      txt.setAttribute('aria-label', `Entry ${i + 1}`);
      txt.addEventListener('input', () => { item.label = txt.value; save(); resetWheel(); });
      txt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('newItem').focus(); } });
      txt.addEventListener('blur', () => {
        if (!txt.value.trim() && items.includes(item)) { items.splice(items.indexOf(item), 1); commit(); }
      });

      const x = document.createElement('button');
      x.type = 'button'; x.className = 'x'; x.innerHTML = X_ICON;
      x.setAttribute('aria-label', `Remove ${item.label || 'entry'}`);
      x.addEventListener('click', () => { items.splice(items.indexOf(item), 1); commit(); });

      li.append(dot, txt, x);
      listEl.append(li);
    });

    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'empty'; p.textContent = 'Nothing on the wheel yet.';
      listEl.append(p);
    }

    const add = document.createElement('li');
    add.className = 'add';
    add.innerHTML = '<svg class="plus" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.4"/><path d="M9 5.5v7M5.5 9h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input type="text" id="newItem" placeholder="Add entry" maxlength="60" aria-label="Add entry" autocomplete="off">';
    listEl.append(add);
    add.querySelector('input').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const val = e.target.value.trim();
      if (!val) return;
      const used = new Set(items.map(x => x.color.toLowerCase()));
      let k = items.length, color = autoColor(k);
      for (let t = 0; t < 48 && used.has(color); t++) color = autoColor(++k);
      items.push({ label: val, color });
      commit();
      const next = $('newItem'); next.focus();
      listEl.scrollTop = listEl.scrollHeight;
    });
  }

  // Back to the start position: pointer centred on the first entry, no highlight
  function resetWheel() {
    rotation = items.length ? -(360 / items.length) / 2 : 0;
    winner = -1;
    result.classList.remove('show');
    lastIndex = indexAtPointer();
    draw();
  }

  function commit() {
    save(); renderList(); resetWheel();
  }

  $('clearAll').addEventListener('click', () => {
    if (items.length && confirm('Remove every entry from the wheel?')) { items = []; commit(); }
  });
  $('recolor').addEventListener('click', () => { items.forEach((it, i) => it.color = autoColor(i)); commit(); });

  function syncRange() {
    spinTimeOut.textContent = `${seconds}s`;
    spinTime.style.setProperty('--fill', `${(seconds - 1) / 19 * 100}%`);
  }
  spinTime.addEventListener('input', () => { seconds = +spinTime.value; syncRange(); save(); });

  canvas.addEventListener('click', spin);
  spinBtn.addEventListener('click', spin);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideResult();
  });

  // ---------- Init ----------
  load();
  spinTime.value = seconds; syncRange();
  renderList();
  resetWheel();
  new ResizeObserver(draw).observe(wrap);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', draw);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  draw();
})();
