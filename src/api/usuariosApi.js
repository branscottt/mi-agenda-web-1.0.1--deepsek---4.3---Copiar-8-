// src/api/usuariosApi.js
// API de usuarios para el panel super_admin.
// Usa RPCs SECURITY DEFINER con validación is_super_admin() en lugar de la
// vista usuarios_con_rol (bloqueada: exponía emails de todos los usuarios
// y permitía UPDATE/DELETE sobre auth.users — migración 20260812_security_fixes).
import { getSupabase } from '../shared/infrastructure/supabase.js';

export async function getAllUsuarios() {
    const { data, error } = await getSupabase()
        .rpc('get_all_users_for_superadmin');
    if (error) throw error;
    return data || [];
}

export async function getUsuarioById(id) {
    const users = await getAllUsuarios();
    return users.find(u => u.id === id) || null;
}

export async function updateUsuarioRol(userId, nuevoRol) {
    const { error } = await getSupabase()
        .rpc('actualizar_rol_usuario', { p_user_id: userId, p_rol: nuevoRol });
    if (error) throw error;
    return true;
}

export async function deleteUsuario(userId) {
    const { error } = await getSupabase()
        .rpc('eliminar_usuario', { p_user_id: userId });
    if (error) throw error;
    return true;
}
