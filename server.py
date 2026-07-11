#!/usr/bin/env python3
"""
Servidor HTTP endurecido para Agenda Pro.
- Bloquea directory listing
- Bloquea rutas sensibles (/scripts, /spec, /Untitled-1.sql, /node_modules)
- Whitelist de extensiones permitidas
- Cabeceras de seguridad HTTP (CSP, XFO, XCTO, Referrer-Policy)
"""
import os
import sys
import http.server
import urllib.parse

BLOCKED_PATHS = ('/scripts', '/spec', '/Untitled-1.sql', '/node_modules', '/src', '/script.js', '/build.js', '/package.json', '/package-lock.json')

ALLOWED_EXTENSIONS = (
    '.html', '.css', '.js',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot',
    '.json', '.txt', '.xml'
)


class SecureHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    # Eliminar header Server (evita exposicion de version Python)
    def version_string(self):
        return ''

    def do_GET(self):
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
    print("Protegido: directory listing OFF, paths sensibles -> 404, whitelist extensiones, CSP activo")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        server.server_close()
