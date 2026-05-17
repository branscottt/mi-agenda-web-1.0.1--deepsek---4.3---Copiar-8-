// src/orchestrator/AppointmentsOrchestrator.js
// Orquestador de citas: unifica los wrappers de screaming architecture
// en un solo punto de entrada para consumidores externos.
import { createCita, upsertCita } from '../CreateCita.js';
import { cancelCita } from '../CancelCita.js';
import { listCitas } from '../ListCitas.js';
import { updateCita } from '../UpdateCita.js';

export const AppointmentsOrchestrator = {
    create: createCita,
    upsert: upsertCita,
    cancel: cancelCita,
    list: listCitas,
    update: updateCita,
};