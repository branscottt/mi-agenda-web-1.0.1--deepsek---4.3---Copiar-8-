// tenants/application/TenantService.js
// CRUD de tenants - delega a src/api/tenantsApi.js

import { getAllTenants as apiGetAll, getTenantByEmail as apiGetByEmail, createTenant, updateTenant, deleteTenant as apiDelete } from '../../api/tenantsApi.js';

export async function getAllTenants() {
    const data = await apiGetAll();
    return data || [];
}

export async function getTenantByEmail(email) {
    try {
        return await apiGetByEmail(email) || null;
    } catch (e) {
        if (e.code === 'PGRST116') return null;
        throw e;
    }
}

export async function saveTenant(tenant) {
    let result;
    if (tenant.id) {
        result = await updateTenant(tenant.id, tenant);
    } else {
        result = await createTenant(tenant);
    }
    return result;
}

export async function deleteTenant(id) {
    await apiDelete(id);
    return true;
}