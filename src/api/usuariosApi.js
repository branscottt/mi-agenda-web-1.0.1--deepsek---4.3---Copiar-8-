// src/api/usuariosApi.js
// API unica para la vista usuarios_con_rol (auth.users con metadatos)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const VIEW = 'usuarios_con_rol';

export async function getAllUsuarios() {
    const { data, error } = await getSupabase()
        .from(VIEW)
        .select('*');
    if (error) throw error;
    return data || [];
}

export async function getUsuarioById(id) {
    const { data, error } = await getSupabase()
        .from(VIEW)
        .select('*')
        .eq('id', id)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

export async function updateUsuarioRol(userId, nuevoRol) {
    const { error } = await getSupabase()
        .from(VIEW)
        .update({ rol: nuevoRol })
        .eq('id', userId);
    if (error) throw error;
    return true;
}

export async function deleteUsuario(userId) {
    const { error } = await getSupabase()
        .from(VIEW)
        .delete()
        .eq('id', userId);
    if (error) throw error;
    return true;
}