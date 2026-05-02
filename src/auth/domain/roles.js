// auth/domain/roles.js
// Enumeracion de roles del sistema

export const ROL = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    CLIENTE: 'cliente'
};

export function esRolValido(rol) {
    return Object.values(ROL).includes(rol);
}

export function puedeAcceder(rol, pagina) {
    const acceso = {
        [ROL.SUPER_ADMIN]: ['superadmin.html', 'login.html'],
        [ROL.ADMIN]: ['admin.html', 'login.html', 'planes.html', 'cliente.html'],
        [ROL.CLIENTE]: ['cliente.html', 'login.html']
    };
    return (acceso[rol] || []).includes(pagina);
}