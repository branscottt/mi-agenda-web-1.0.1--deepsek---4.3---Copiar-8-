// sw.js — Service Worker para Agenda Pro
// Estrategia: Cache First para assets estáticos, Network Only para API.
// Se activa solo en visitas repetidas (no cambia la primera carga).

const CACHE_NAME = 'agendapro-v1';
const STATIC_ASSETS = [
    '/dist/app.js',
    '/dist/legacy.js',
    '/dist/style.css',
    '/admin.html',
    '/cliente.html',
    '/login.html',
    '/planes.html',
    '/trabajador.html',
    '/superadmin.html'
];

// CDN assets que también se cachean (versiones fijas)
const CDN_CACHEABLE = [
    'cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'cdnjs.cloudflare.com/ajax/libs/font-awesome',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

// ── INSTALL: Precargar assets estáticos ──
self.addEventListener('install', (event) => {
    console.log('[SW] Install');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Cachear assets locales (ignorar fallos individuales)
            return Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    cache.add(url).catch(() => {
                        // Ignorar errores de assets individuales
                    })
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// ── ACTIVATE: Limpiar caches viejos ──
self.addEventListener('activate', (event) => {
    console.log('[SW] Activate');
    event.waitUntil(
        caches.keys().then((names) => {
            return Promise.all(
                names
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// ── FETCH: Interceptar peticiones ──
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // 1. API calls a Supabase → Nunca cachear (Network Only)
    if (url.includes('supabase.co')) {
        return;
    }

    // 2. Assets locales (dist/) → Cache First
    if (url.includes('/dist/') || url.endsWith('.css') || url.endsWith('.js')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                return cached || fetchAndCache(event.request);
            })
        );
        return;
    }

    // 3. Páginas HTML → Network First (pero cachear para offline)
    if (url.endsWith('.html') || !url.includes('.')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // 4. CDN (font-awesome, google fonts, supabase SDK) → Cache First
    if (CDN_CACHEABLE.some(cdn => url.includes(cdn))) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                return cached || fetchAndCache(event.request);
            })
        );
        return;
    }

    // 5. Default: Network First
    event.respondWith(
        fetch(event.request)
            .catch(() => caches.match(event.request))
    );
});

async function fetchAndCache(request) {
    const response = await fetch(request);
    if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
    }
    return response;
}
