// src/api/serviciosTrabajadoresApi.js
// API de relación servicios ↔ trabajadores (N:N)

export async function getTrabajadoresByServicio(servicioId) {
    const supabase = window.supabaseClient;
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('servicios_trabajadores')
        .select('trabajador_id, trabajadores!inner(*)')
        .eq('servicio_id', servicioId);
    if (error) {
        console.error('Error getTrabajadoresByServicio:', error);
        return [];
    }
    return (data || []).map(r => r.trabajadores).filter(Boolean);
}

export async function getServiciosByTrabajador(trabajadorId) {
    const supabase = window.supabaseClient;
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('servicios_trabajadores')
        .select('servicio_id, servicios!inner(*)')
        .eq('trabajador_id', trabajadorId);
    if (error) {
        console.error('Error getServiciosByTrabajador:', error);
        return [];
    }
    return (data || []).map(r => r.servicios).filter(Boolean);
}

export async function setTrabajadoresForServicio(servicioId, trabajadorIds) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');

    // Eliminar relaciones existentes
    const { error: delError } = await supabase
        .from('servicios_trabajadores')
        .delete()
        .eq('servicio_id', servicioId);
    if (delError) throw delError;

    if (!trabajadorIds || trabajadorIds.length === 0) return [];

    // Insertar nuevas relaciones
    const inserts = trabajadorIds.map(tid => ({
        servicio_id: servicioId,
        trabajador_id: tid
    }));
    const { data, error } = await supabase
        .from('servicios_trabajadores')
        .insert(inserts)
        .select();
    if (error) throw error;
    return data || [];
}
