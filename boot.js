// Runs in <head>, before the page paints. Two jobs, so a refresh looks right instantly:
//  1. pick the view (wheel or slot reel) so the right one shows on first paint
//  2. paint the saved wheel colors as a stand-in until script.js draws the real wheel
// It lives in its own file (not inline) so the Content Security Policy can forbid
// inline scripts entirely. It only reads this site's own saved data, and only
// strictly validated hex colors ever reach the page's styles.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('spinwheel:v1') || 'null');
    var list = saved && Array.isArray(saved.items) ? saved.items : [];
    var items = list.filter(function (x) { return x && typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color); });
    var st = (saved && saved.settings) || {};
    var slotAt = Math.min(500, Math.max(20, +st.slotAt || 100));
    var view = st.view === 'wheel' || st.view === 'slot' ? st.view : (items.length > slotAt ? 'slot' : 'wheel');
    document.documentElement.dataset.view = view;
    if (view === 'slot' || !items.length) return;
    var a = 360 / items.length, stops = [];
    for (var i = 0; i < items.length; i++) stops.push(items[i].color + ' ' + i * a + 'deg ' + (i + 1) * a + 'deg');
    document.documentElement.style.setProperty('--wheel-bg', 'conic-gradient(from ' + -a / 2 + 'deg, ' + stops.join(', ') + ')');
  } catch (e) { /* storage blocked or corrupt: script.js starts fresh */ }
})();
