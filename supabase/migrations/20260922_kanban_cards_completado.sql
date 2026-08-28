-- ============================================================
-- MIGRACIÓN: Tarjetas marcables como hechas (checklist de tareas)
-- Fecha: 2026-09-22
--
-- PROBLEMA: el usuario quiere usar las tarjetas como un grupo de
-- tareas por hacer: la lista = nombre de la tarea general y cada
-- tarjeta = un punto/ítem que se puede marcar como hecho desde
-- el tablero, sin abrir el modal.
--
-- SOLUCIÓN: columna completado en kanban_cards (checkbox circular
-- en la tarjeta del board, estilo tachado al completar).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

ALTER TABLE public.kanban_cards ADD COLUMN IF NOT EXISTS completado boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';

SELECT '✅ kanban_cards.completado agregado (tarjetas como checklist de tareas)' AS status;
