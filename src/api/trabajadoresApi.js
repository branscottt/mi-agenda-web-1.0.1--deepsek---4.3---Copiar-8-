// src/api/trabajadoresApi.js
// API de trabajadores — CRUD contra Supabase

export async function getTrabajadores(tenantId) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .select('id, tenant_id, nombre, email, telefono, color, activo, tipo_jornada, horario_semanal, horario_excepciones, horario_max_semanal, habilidades, created_at')
        .eq('tenant_id', String(tenantId).trim())
        .order('nombre');
    if (error) throw error;
    return data || [];
}

export async function getTrabajadoresActivos(tenantId) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .select('id, tenant_id, nombre, email, telefono, color, activo, tipo_jornada, horario_semanal, horario_excepciones, horario_max_semanal, habilidades, created_at')
        .eq('tenant_id', String(tenantId).trim())
        .eq('activo', true)
        .order('nombre');
    if (error) throw error;
    return data || [];
}

export async function getTrabajadorById(id) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .select('*')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function createTrabajador(trabajador) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .insert(trabajador)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function updateTrabajador(id, updates) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteTrabajador(id) {
    // Borrado real: ON DELETE SET NULL en citas, CASCADE en servicios_trabajadores
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { error } = await supabase
        .from('trabajadores')
        .delete()
        .eq('id', id);
    if (error) throw error;
    return true;
}
