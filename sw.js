// sw.js — Service Worker para Agenda Pro
// Estrategia: Cache First para assets estáticos, Network Only para API.
// Se activa solo en visitas repetidas (no cambia la primera carga).

const CACHE_NAME = 'agendapro-v44';
// Solo assets estáticos con hash/versión fija se precachean.
// Los HTML NO se precachean: cada deploy cambia headers (CSP) y estructura,
// y un HTML viejo en caché rompe la navegación y la política de seguridad.
const STATIC_ASSETS = [
    '/style.css'
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

    // 2. Assets locales (CSS, fuentes, imagenes) → Cache First
    //    En producción (Vercel outputDirectory=dist) y en dev los assets
    //    viven en la raíz: /style.css, /img/... (no /dist/)
    const isLocalAsset = /\.(css|woff2?|ttf|eot|png|svg|ico|jpg|jpeg|webp|gif)$/.test(url) &&
        url.startsWith(self.location.origin);
    if (isLocalAsset) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                return cached || fetchAndCache(event.request);
            })
        );
        return;
    }

    // 3. JS files (app.js, legacy.js, chunks/) → Network First, nunca cachear
    //    Los chunks de code-splitting cambian de nombre con cada build
    if (url.endsWith('.js')) {
        event.respondWith(
            fetch(event.request)
                .then(response => response)
                .catch(() => caches.match(event.request).then(c => c || new Response('', { status: 404 })))
        );
        return;
    }

    // 3. Páginas HTML → Network First estricto: SIEMPRE red si está disponible.
    //    Nunca servir HTML cacheado cuando hay red (evita CSP vieja / estructura vieja).
    //    La copia en caché solo se usa como fallback offline (y se refresca con cada visita).
    if (url.endsWith('.html') || !url.includes('.')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
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
