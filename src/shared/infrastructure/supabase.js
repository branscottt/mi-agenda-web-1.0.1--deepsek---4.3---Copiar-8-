// shared/infrastructure/supabase.js
// Inicialización y export del cliente Supabase

const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0';

let _client = null;

export function getSupabase() {
    if (!_client) {
        if (!window.supabase) {
            console.error('Supabase SDK no cargado.');
            return null;
        }
        _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    return _client;
}

const supabase = getSupabase();
export { supabase as supabaseClient };

// Mantener compatibilidad hacia atras con script.js
window.supabaseClient = supabaseClient;