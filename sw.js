// Service worker: gives the site long-term caching on GitHub Pages,
// which only lets browsers cache files for 10 minutes.
//
// - The page itself: network first, so a new deploy shows up on the next visit.
//   Falls back to the cached copy when offline.
// - Everything else (CSS, JS, font, Papa Parse): cache first. The build gives CSS
//   and JS hashed names, and each deploy gets a new cache, so nothing goes stale.
//
// build.mjs fills in VERSION and PRECACHE. The unbuilt file is never served.

const VERSION = '__VERSION__';
const CACHE = `wheel-${VERSION}`;
const PRECACHE = [/* __PRECACHE__ */];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('wheel-') && k !== CACHE).map(k => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

function store(request, response) {
  if (response.ok && response.type === 'basic') {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => store(request, response))
        .catch(() => caches.match(request).then(hit => hit ?? caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(hit => hit ?? fetch(request).then(response => store(request, response))),
  );
});
