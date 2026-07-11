#!/usr/bin/env python3
"""
Servidor HTTP seguro para Agenda Pro.
Bloquea el acceso a .git/, archivos ocultos (.*) y node_modules/.
"""
import os
import sys
import http.server
import urllib.parse

BLOCKED_PREFIXES = ('/.git', '/.env', '/.htaccess', '/.DS_Store', '/node_modules/')
BLOCKED_EXTENSIONS = ('.env',)

class SecureHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'

        # Bloquear directorio .git completo
        if '/.git' in path or path.startswith('/.git'):
            self.send_error(404, 'Not Found')
            return

        # Bloquear cualquier archivo/directorio que empiece con punto
        # (archivos ocultos como .env, .htaccess, .DS_Store, etc.)
        segments = [s for s in path.split('/') if s]
        for seg in segments:
            if seg.startswith('.'):
                self.send_error(404, 'Not Found')
                return

        # Bloquear node_modules
        if '/node_modules/' in path or path.startswith('/node_modules'):
            self.send_error(404, 'Not Found')
            return

        return super().do_GET()

    def do_HEAD(self):
        self.do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    bind = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'
    directory = sys.argv[3] if len(sys.argv) > 3 else '.'

    os.chdir(directory)
    server = http.server.HTTPServer((bind, port), SecureHTTPRequestHandler)
    print(f"Servidor seguro corriendo en http://{bind}:{port}")
    print(f"Directorio: {os.path.abspath(directory)}")
    print(f"Protegido: .git/, archivos ocultos (.*), node_modules/ → 404")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        server.server_close()
