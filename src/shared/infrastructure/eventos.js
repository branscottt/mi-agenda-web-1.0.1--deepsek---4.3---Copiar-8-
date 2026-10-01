// src/shared/infrastructure/eventos.js
// Analítica PROPIA de uso — NO depende de PostHog (que sigue apagado por
// falta de API key). Cada evento se guarda en public.tenant_eventos vía la RPC
// registrar_evento (SECURITY DEFINER: el tenant sale del usuario autenticado).
//
// Para qué sirve: que el superadmin pueda ver QUÉ HACE cada negocio y qué NO
// (¿usa la mudanza?, ¿usa el trello?, ¿usa ventas live?, ¿se quedó en crear el
// primer servicio?) y decidir qué mejorar.
//
// Reglas:
//   - NUNCA rompe la UI: todo en try/catch y sin await (fire-and-forget).
//   - Sin datos personales en props (solo conteos y nombres de sección).
//   - `unaVezPorCarga` evita contar el mismo aviso 20 veces en una sesión.
import { getSupabase } from './supabase.js';

const YA_EN_ESTA_CARGA = new Set();

export function registrarEvento(evento, props = {}, opts = {}) {
    try {
        const nombre = String(evento || '').trim();
        if (nombre.length < 3) return;

        if (opts && opts.unaVezPorCarga) {
            if (YA_EN_ESTA_CARGA.has(nombre)) return;
            YA_EN_ESTA_CARGA.add(nombre);
        }

        const sb = (typeof window !== 'undefined' && window.supabaseClient) || getSupabase();
        if (!sb || typeof sb.rpc !== 'function') return;

        Promise.resolve(
            sb.rpc('registrar_evento', { p_evento: nombre, p_props: props || {} })
        ).catch(() => { /* sin sesión / sin red: se ignora */ });
    } catch (e) {
        /* la analítica jamás interrumpe al usuario */
    }
}

export default registrarEvento;
