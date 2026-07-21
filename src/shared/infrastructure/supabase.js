// shared/infrastructure/supabase.js
// Inicialización y export del cliente Supabase
import { getAppConfig } from './config.js';

let _client = null;

export function getSupabase() {
    // Reutilizar cliente global si ya existe (creado por main.js)
    if (window.supabaseClient) {
        _client = window.supabaseClient;
        return _client;
    }
    if (!_client) {
        if (!window.supabase) {
            console.error('Supabase SDK no cargado.');
            return null;
        }
        _client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    }
    return _client;
}

const cfg = getAppConfig();
const supabase = getSupabase();
export { supabase as supabaseClient };