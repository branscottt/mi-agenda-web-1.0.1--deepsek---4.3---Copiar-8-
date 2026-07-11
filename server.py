#!/usr/bin/env python3
"""
Servidor HTTP endurecido para Agenda Pro.
- Bloquea directory listing
- Bloquea rutas sensibles (/scripts, /spec, /Untitled-1.sql, /node_modules)
- Whitelist de extensiones permitidas
- Cabeceras de seguridad HTTP (CSP, XFO, XCTO, Referrer-Policy)
- Rate limiting: 10 solicitudes/minuto por IP y por username (X-Username)
"""
import os
import sys
import time
import collections
import http.server
import urllib.parse

BLOCKED_PATHS = ('/scripts', '/spec', '/Untitled-1.sql', '/node_modules', '/src', '/script.js', '/build.js', '/package.json', '/package-lock.json')

ALLOWED_EXTENSIONS = (
    '.html', '.css', '.js',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot',
    '.json', '.txt', '.xml'
)

RATE_LIMIT_MAX = 10          # solicitudes maximo
RATE_LIMIT_WINDOW = 60       # ventana en segundos


class RateLimiter:
    """Rate limiter con ventana deslizante por key (IP o username).

    Por cada key registra timestamps y poda los que quedan fuera de la
    ventana en cada consulta.  No requiere hilos porque HTTPServer maneja
    las peticiones secuencialmente.
    """

    def __init__(self, max_requests=RATE_LIMIT_MAX, window_seconds=RATE_LIMIT_WINDOW):
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


_rate_limiter = RateLimiter()
_request_counter = 0          # contador para prune_expired periodico


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

    def _check_rate_limit(self):
        """Verifica rate limiting por IP y por username (X-Username).
        Retorna True si la solicitud debe continuar, False si debe ser
        rechazada con 429."""
        client_ip = self._get_client_ip()
        username = self.headers.get('X-Username', '').strip()

        # 1. Verificar por IP
        if not _rate_limiter.is_allowed(client_ip):
            retry_after = _rate_limiter.get_retry_after(client_ip)
            self._send_rate_limit_error(retry_after, client_ip)
            return False

        # 2. Verificar por username (si el cliente lo envia)
        if username and not _rate_limiter.is_allowed(username):
            retry_after = _rate_limiter.get_retry_after(username)
            self._send_rate_limit_error(retry_after, username)
            return False

        return True

    def _send_rate_limit_error(self, retry_after, key):
        """Envia respuesta 429 Too Many Requests con Retry-After."""
        message = (
            f"429 Too Many Requests\n"
            f"Limite de {RATE_LIMIT_MAX} solicitudes por minuto excedido.\n"
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
        # 0. RATE LIMITING — primero, antes de cualquier procesamiento
        # ============================================================
        if not self._check_rate_limit():
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'

        # Poda periodica del rate limiter (cada 100 requests)
        global _request_counter
        _request_counter += 1
        if _request_counter % 100 == 0:
            _rate_limiter.prune_expired()

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

        # 6. Servir archivo (end_headers agrega cabeceras de seguridad)
        return super().do_GET()

    def end_headers(self):
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
        self.send_header(
            'Content-Security-Policy',
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
            "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; "
            "img-src 'self' data: https:; "
            "connect-src 'self' https://dfcfimipkfhitlsyixqu.supabase.co; "
            "form-action 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "upgrade-insecure-requests"
        )
        super().end_headers()

    def list_directory(self, path):
        """Deshabilitar directory listing completamente."""
        self.send_error(404, 'Not Found')
        return None

    def do_HEAD(self):
        self.do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    bind = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'
    directory = sys.argv[3] if len(sys.argv) > 3 else '.'

    os.chdir(directory)
    server = http.server.HTTPServer((bind, port), SecureHTTPRequestHandler)
    print(f"Servidor endurecido en http://{bind}:{port}")
    print(f"Directorio: {os.path.abspath(directory)}")
    print(f"Rate limit: {RATE_LIMIT_MAX} solicitudes/{RATE_LIMIT_WINDOW}s por IP y por username")
    print("Protegido: directory listing OFF, paths sensibles -> 404, whitelist extensiones, CSP activo, rate limit ON")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        server.server_close()
