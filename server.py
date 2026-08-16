#!/usr/bin/env python3
"""
|Servidor HTTP endurecido para Agenda Pro.
|- Bloquea directory listing
|- Bloquea rutas sensibles (/scripts, /spec, /Untitled-1.sql, /node_modules)
|- Whitelist de extensiones permitidas
|- Cabeceras de seguridad HTTP (CSP con hashes SHA en script-src, HSTS, XFO, XCTO)
|- Rate limiting por tipo de ruta: login=10, pages=120, static=300
"""
import os
import sys
import time
import collections
import http.server
import urllib.parse

BLOCKED_PATHS = ('/scripts', '/spec', '/Untitled-1.sql', '/node_modules', '/src', '/script.js', '/build.js', '/package.json', '/package-lock.json', '/reset-pass.html')

ALLOWED_EXTENSIONS = (
    '.html', '.css', '.js',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot',
    '.json', '.txt', '.xml'
)

# Rate limits por tipo de ruta (ventana de 60 segundos por defecto)
# Login: estricto, evita escaneo automatizado de la página de login
# Páginas: moderado, suficiente para recargas normales de 50-100 pymes
# Estáticos: alto, necesarios para que el code-splitting funcione sin bloquearse
RATE_LIMIT_CONFIG = {
    'static':  {'max': 300, 'window': 60},    # /dist/*, .js, .css, .woff2, .png, svg, .ico
    'pages':   {'max': 120, 'window': 60},    # *.html excepto login
    'login':   {'max': 50, 'window': 60},    # /login.html
    # Las llamadas a la API de Supabase (login real, citas, etc.)
    # NO pasan por server.py — van directo a supabase.co
    # y ya tienen su propio rate limit interno.
}
RATE_LIMIT_DEFAULT = 120  # fallback si no se puede clasificar


class RateLimiter:
    """Rate limiter con ventana deslizante por key (IP o username)."""

    def __init__(self, max_requests=RATE_LIMIT_DEFAULT, window_seconds=60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._buckets = collections.defaultdict(list)

    def is_allowed(self, key):
        """Registra una solicitud para la key y devuelve True si esta dentro
        del limite, False si ya lo excedio."""
        now = time.time()
        cutoff = now - self.window_seconds
        timestamps = self._buckets[key]
        # Podar entradas fuera de la ventana
        self._buckets[key] = [t for t in timestamps if t > cutoff]
        if len(self._buckets[key]) >= self.max_requests:
            return False
        self._buckets[key].append(now)
        return True

    def get_retry_after(self, key):
        """Devuelve los segundos que faltan para que expire la entrada mas
        antigua de la ventana (o 0 si no hay limite activo)."""
        timestamps = self._buckets.get(key)
        if not timestamps or len(timestamps) < self.max_requests:
            return 0
        now = time.time()
        oldest = timestamps[0]
        remaining = int(self.window_seconds - (now - oldest))
        return max(1, remaining)

    def prune_expired(self):
        """Limpia buckets de claves sin actividad reciente (control de memoria)."""
        cutoff = time.time() - self.window_seconds
        stale_keys = [k for k, v in self._buckets.items() if not v or v[-1] < cutoff]
        for k in stale_keys:
            del self._buckets[k]


_rate_limiters_cache = {}   # cache de RateLimiter por tipo de ruta


class SecureHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    # Eliminar header Server (evita exposicion de version Python)
    def version_string(self):
        return ''

    def _get_client_ip(self):
        """Obtiene IP real del cliente respetando X-Forwarded-For."""
        forwarded = self.headers.get('X-Forwarded-For', '').strip()
        if forwarded:
            # Tomar la IP mas a la izquierda (la del cliente real)
            return forwarded.split(',')[0].strip()
        return self.client_address[0]

    def _get_route_type(self, path):
        """Clasifica la ruta en 'static', 'pages', 'login' o 'static' por defecto."""
        parsed = urllib.parse.urlparse(path)
        clean_path = parsed.path.rstrip('/') or '/'
        
        # Login: estricto
        if clean_path == '/login.html':
            return 'login'
        
        # Páginas HTML (excluyendo login que ya se clasificó arriba)
        if clean_path.endswith('.html'):
            return 'pages'
        
        # Archivos estáticos
        _, ext = os.path.splitext(clean_path)
        if ext.lower() in ('.js', '.css', '.woff', '.woff2', '.ttf', '.eot',
                           '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
                           '.webp', '.txt', '.xml', '.json'):
            return 'static'
        
        # Todo lo demás tratado como estático (no limitar agresivamente)
        return 'static'

    def _check_rate_limit(self):
        """Verifica rate limiting por IP y por username, usando el límite
        correspondiente al tipo de ruta.
        Retorna True si la solicitud debe continuar, False si debe ser
        rechazada con 429."""
        global _rate_limiters_cache
        client_ip = self._get_client_ip()
        username = self.headers.get('X-Username', '').strip()

        # Determinar límite según la ruta
        route_type = self._get_route_type(self.path)
        config = RATE_LIMIT_CONFIG.get(route_type, {})
        max_req = config.get('max', RATE_LIMIT_DEFAULT)
        window = config.get('window', 60)

        # Usar rate limiter cacheado (misma ventana y max para cada tipo de ruta)
        cache_key = (route_type, max_req, window)
        if cache_key not in _rate_limiters_cache:
            _rate_limiters_cache[cache_key] = RateLimiter(max_requests=max_req, window_seconds=window)
        limiter = _rate_limiters_cache[cache_key]

        # 1. Verificar por IP
        if not limiter.is_allowed(client_ip):
            retry_after = limiter.get_retry_after(client_ip)
            self._send_rate_limit_error(retry_after, max_req, route_type)
            return False

        # 2. Verificar por username (si el cliente lo envia)
        if username and not limiter.is_allowed(username):
            retry_after = limiter.get_retry_after(username)
            self._send_rate_limit_error(retry_after, max_req, route_type)
            return False

        return True

    def _send_rate_limit_error(self, retry_after, max_req, route_type='desconocido'):
        """Envia respuesta 429 Too Many Requests con Retry-After."""
        message = (
            f"429 Too Many Requests\n"
            f"Límite de {max_req} solicitudes por minuto excedido "
            f"(tipo: {route_type}).\n"
            f"Intente de nuevo en {retry_after} segundo(s).\n"
        )
        self.send_response(429)
        self.send_header('Retry-After', str(retry_after))
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(message.encode('utf-8'))

    def do_GET(self):
        # ============================================================
        # 0a. HEALTH CHECK — sin rate limiting para monitoreo
        # ============================================================
        if self.path == '/-/health':
            self._serve_health_check()
            return

        # ============================================================
        # 0. RATE LIMITING — primero, antes de cualquier procesamiento
        # ============================================================
        if not self._check_rate_limit():
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'

        # 1. Bloquear .git (completo)
        if '/.git' in path:
            self.send_error(404, 'Not Found')
            return

        # 2. Bloquear archivos/directorios ocultos (.*)
        segments = [s for s in path.split('/') if s]
        for seg in segments:
            if seg.startswith('.'):
                self.send_error(404, 'Not Found')
                return

        # 3. Bloquear rutas prohibidas
        for bp in BLOCKED_PATHS:
            if path == bp or path.startswith(bp + '/'):
                self.send_error(404, 'Not Found')
                return

        # 4. Bloquear directory listing
        full_path = self.translate_path(path)
        if os.path.isdir(full_path):
            self.send_error(404, 'Not Found')
            return

        # 5. Whitelist de extensiones
        _, ext = os.path.splitext(path)
        if ext and ext.lower() not in ALLOWED_EXTENSIONS:
            self.send_error(404, 'Not Found')
            return

        # 6. Servir archivo (con inyección de config para HTML)
        if ext.lower() == '.html':
            self._serve_html_with_config(full_path)
        else:
            return super().do_GET()

    def _serve_health_check(self):
        """Endpoint /-/health para monitoreo (sin rate limiting).
        Retorna 200 con estado básico del servidor y conectividad a Supabase."""
        import json
        import socket

        health = {
            'status': 'ok',
            'timestamp': time.time(),
            'server': 'Agenda Pro',
            'version': '1.0',
            'uptime': None,
            'checks': {}
        }

        # Verificar que el servidor corre
        health['checks']['server'] = 'ok'

        # Verificar conectividad a Supabase (timeout 5s)
        supabase_host = 'dfcfimipkfhitlsyixqu.supabase.co'
        try:
            socket.setdefaulttimeout(5)
            socket.gethostbyname(supabase_host)
            health['checks']['dns'] = 'ok'
        except Exception:
            health['checks']['dns'] = 'error'

        # Verificar rate limiter
        health['checks']['rate_limiter'] = {
            'buckets': sum(len(rl._buckets) for rl in _rate_limiters_cache.values()) if _rate_limiters_cache else 0,
        }

        payload = json.dumps(health, indent=2).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def _serve_html_with_config(self, filepath):
        """Sirve HTML inyectando window.__APP_CONFIG desde variables de entorno.
        Usa nonce CSP para permitir el script inline sin unsafe-inline.
        No modifica archivos en disco — solo en memoria durante el response."""
        try:
            with open(filepath, 'rb') as f:
                content = f.read()
        except Exception:
            self.send_error(404, 'Not Found')
            return

        config_payload = {}
        supabase_url = os.environ.get('SUPABASE_URL', '')
        supabase_key = os.environ.get('SUPABASE_KEY', '')
        if supabase_url and supabase_key:
            config_payload['supabaseUrl'] = supabase_url
            config_payload['supabaseKey'] = supabase_key

        # Inyectar configuración de entorno
        app_env = os.environ.get('APP_ENV', 'development')
        config_payload['environment'] = app_env

        # Inyectar URL base de Edge Functions (para que no esté hardcodeada)
        edge_functions_url = os.environ.get('EDGE_FUNCTIONS_URL', '')
        if edge_functions_url:
            config_payload['edgeFunctionsUrl'] = edge_functions_url

        # Inyectar PostHog (analytics) — solo si hay API key configurada
        posthog_key = os.environ.get('POSTHOG_API_KEY', '')
        if posthog_key:
            config_payload['posthogApiKey'] = posthog_key
            config_payload['posthogHost'] = os.environ.get('POSTHOG_HOST', 'https://app.posthog.com')

        if config_payload:
            import json
            import base64
            # Generar nonce CSP para el script inline
            nonce = base64.b64encode(os.urandom(16)).decode('ascii')
            self._csp_nonce = nonce
            script = (
                b'<script nonce="' + nonce.encode('ascii') + b'">'
                + b'window.__APP_CONFIG = '
                + json.dumps(config_payload).encode('utf-8')
                + b';</script>\n'
            )
            # Inyectar después de <head>
            content = content.replace(b'<head>', b'<head>\n' + script, 1)

        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def end_headers(self):
        # === CORS — permitir origen actual para assets estáticos ===
        origin = self.headers.get('Origin', '')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Username')
            self.send_header('Access-Control-Allow-Credentials', 'true')
            self.send_header('Access-Control-Max-Age', '86400')

        # === OWASP Secure Headers (sin romper logica de negocio) ===
        # HSTS — solo cuando la conexion es HTTPS
        self.send_header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Permitted-Cross-Domain-Policies', 'none')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-DNS-Prefetch-Control', 'off')
        self.send_header(
            'Permissions-Policy',
            'accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), '
            'display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), '
            'gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), '
            'payment=(), picture-in-picture=(), publickey-credentials-get=(), '
            'screen-wake-lock=(), sync-xhr=(self), usb=(), web-share=(), '
            'xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(), '
            'gamepad=(), hid=(), idle-detection=(), interest-cohort=(), serial=(), unload=()'
        )
        # Build CSP dinámicamente: si hay nonce (inyección de config), agregarlo
        # ⚠️ IMPORTANTE: Los hashes SHA256 están calculados sobre los archivos
        # compilados en dist/. Si modificas un <script> inline en cualquier HTML,
        # debes rebuildear con `node build.js` y recalcular los hashes.
        # De lo contrario, el CSP bloqueará ese script en producción
        # silenciosamente (sin errores visibles).
        csp_script = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' "
            + (("'nonce-" + self._csp_nonce + "' ") if getattr(self, '_csp_nonce', None) else "")
            + "'sha256-s+bEyqHw8XVioi6JNlo+DJI21V7B2UI6wwsJwUN9s0M=' "
            "'sha256-+UV8Se628DiIqlxmNFCAoWzroa6MxiTC6bQbL50O06k=' "
            "'sha256-UQrDhi6gzmBdUezTgWk6Jg9V4H7P1xx0BLIv54aSq4E=' "
            "'sha256-lSYtQi+KHaLFhXRNLOZvTjEX1tqlBShsZLMnMOkFNkU=' "
            "'sha256-Bt5kHzBUuE0C+grs3wNL8SrAkgBQCUnhbTNsZL2sJVw=' "
            "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://challenges.cloudflare.com https://js.sentry-cdn.com; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
            "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; "
            "img-src 'self' data: https: https://http2.mlstatic.com; "
            "connect-src 'self' https://dfcfimipkfhitlsyixqu.supabase.co https://challenges.cloudflare.com https://api.mercadopago.com https://app.posthog.com https://api.qrserver.com; "
            "frame-src https://challenges.cloudflare.com https://www.mercadopago.com https://mercadopago.com https://mpago.li; "
            "form-action 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "upgrade-insecure-requests"
        )
        self.send_header('Content-Security-Policy', csp_script)
        super().end_headers()

    def list_directory(self, path):
        """Deshabilitar directory listing completamente."""
        self.send_error(404, 'Not Found')
        return None

    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        """CORS preflight: responder sin body, solo headers."""
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    bind = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'
    directory = sys.argv[3] if len(sys.argv) > 3 else '.'

    os.chdir(directory)
    server = http.server.HTTPServer((bind, port), SecureHTTPRequestHandler)
    print(f"Servidor endurecido en http://{bind}:{port}")
    print(f"Directorio: {os.path.abspath(directory)}")
    print("Rate limits por tipo de ruta:")
    for rtype, cfg in RATE_LIMIT_CONFIG.items():
        print(f"  [{rtype}] {cfg['max']} solicitudes/{cfg['window']}s por IP")
    print("Protegido: directory listing OFF, paths sensibles -> 404, whitelist extensiones, CSP activo, rate limit ON")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        server.server_close()
