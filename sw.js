// 앱 화면 파일을 저장해 두어 통신이 불안정할 때도 앱이 열리도록 함
// 파일을 고친 뒤에는 CACHE 이름의 숫자를 올리면 휴대폰이 새 버전을 받습니다.
const CACHE = 'canetronics-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './lib/leaflet.js',
  './lib/leaflet.css',
  './lib/mqtt.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 같은 사이트 파일: 네트워크 우선, 실패하면 저장본 사용 (지도 타일·폰트는 브라우저가 직접 처리)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
      list.length ? list[0].focus() : self.clients.openWindow('./')
    )
  );
});
