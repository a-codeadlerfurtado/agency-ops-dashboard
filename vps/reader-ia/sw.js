const CACHE='readerpro-shell-v19-segmented-prefetch';
const SHELL=['/reader/','/reader/app-v2.mjs','/reader/manifest.webmanifest','/reader/assets/icon-192.png','/reader/assets/icon-512.png','/reader/assets/apple-touch-icon.png','/reader/assets/cover-kotler.jpg','/reader/assets/cover-zikmund.jpg','/reader/assets/cover-greene.jpg','/reader/assets/silence.mp3'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',event=>{
  const u=new URL(event.request.url);
  if(event.request.method!=='GET'||u.origin!==location.origin)return;
  if(u.pathname.startsWith('/reader/api/'))return;
  event.respondWith(fetch(event.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});return r;}).catch(()=>caches.match(event.request)));
});