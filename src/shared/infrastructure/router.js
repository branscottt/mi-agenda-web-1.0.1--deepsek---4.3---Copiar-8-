// shared/infrastructure/router.js
// Wrapper para compatibilidad hacia atras.
// Toda la logica de sesion y redireccion se movio a shared/domain/session.js
// para romper la dependencia shared -> auth.
// Este archivo re-exporta las funciones para que los modulos existentes
// sigan funcionando sin cambios en los imports.

export {
    ROLES,
    getSession,
    getCurrentTenantId,
    redirectByRole,
    verificarProteccionRutas
} from '../domain/session.js';