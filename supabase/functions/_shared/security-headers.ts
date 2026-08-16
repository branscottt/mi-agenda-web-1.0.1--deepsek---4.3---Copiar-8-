// supabase/functions/_shared/security-headers.ts
// Cabeceras de seguridad recomendadas por el OWASP Secure Headers Project
// (https://github.com/OWASP/www-project-secure-headers — sección
// "Best Practices > Configuration proposal") aplicadas a las respuestas
// de las Edge Functions (las APIs HTTP de Agenda Pro).
//
// Decisiones documentadas:
//  - HSTS NO se incluye: Cloudflare edge ya la inyecta en producción
//    (max-age=31536000; includeSubDomains; preload). Duplicarla generaría
//    cabeceras redundantes en la respuesta.
//  - Clear-Site-Data NO se incluye: OWASP la limita a respuestas de logout;
//    estas APIs no tienen logout (la sesión se limpia client-side).
//  - CSP mínima de API (valor exacto de la tabla OWASP): en contexto API la
//    política que de verdad aplica es la del documento consumidor — el
//    frontend ya envía su propia CSP con hashes desde Vercel/server.py.
//  - CORP/COEP no rompen el fetch CORS del frontend: CORP solo se aplica a
//    peticiones no-CORS (modo cors lo gobierna el protocolo CORS) y COEP es
//    política del documento, no de respuestas JSON.

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(self), usb=(), web-share=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(), gamepad=(), hid=(), idle-detection=(), interest-cohort=(), serial=(), unload=()',
  'Cache-Control': 'no-store, max-age=0',
  'X-DNS-Prefetch-Control': 'off',
};

/** Añade las cabeceras OWASP a un Response sin pisar cabeceras existentes. */
export function applySecurityHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(key)) {
      response.headers.set(key, value);
    }
  }
  return response;
}
