# Análisis de Especificación — Sistema de Ventas TikTok LIVE + WhatsApp

Fecha: 2026-09-07 · Repo: mi-agenda-web (Copiar 13) · Rama: main (limpia, sin cambios sin commitear)
Método: ciclo cerrado con codebase-memory MCP + verificación en archivos reales. No se modificó código.

---

## 0. Veredicto ejecutivo

Esta especificación NO es un proyecto desde cero para este repo: **ya está implementada en un ~95%**
como el producto "Ventas Live" (proyecto `ventas_live`, segundo workspace multi-tenant de la
plataforma Organify). El código la cita explícitamente ("spec §8", "spec §12", "spec §17", "spec §22").

Lo que **falta** para cumplir la spec al 100% (brechas reales):
1. **Tubería WhatsApp real** (Edge Function de webhook + envío por Graph API de Meta). El "cerebro"
   del bot ya existe; la propia migración 20261019 dice que el webhook llega en un ciclo posterior.
2. **Comprobante de pago** (spec §13 "[VER IMAGEN]"): `vl_pagos` no tiene campo de imagen/archivo.
3. Definición contable de "ganancia estimada" (hoy se calcula sobre dinero *recibido*, no sobre
   ventas *devengadas*).

El resto son mejoras opcionales (etiquetas, destinatario de envío, sugerencia automática de
"posible problemático") y decisiones de negocio que la spec no resuelve (ver §3.3).

---

## 1. Método

1. Index MCP verificado: proyecto `home-branscott-proyectos-mi-agenda-web-1.0.1-deepsek-4.3-Copiar-13`
   (3.302 nodos, apunta a la ruta real del repo; el índice alternativo `mi-agenda-web` está obsoleto).
2. Lectura de migraciones VL (20261012 → 20261020), shell `ventas-live.html`, vistas
   `src/ventas-live/ui/*` y RPCs de dominio/lectura/bot.
3. Mapeo sección-a-sección spec → código con evidencia (archivo:línea).

---

## 2. Mapeo spec → implementación existente

| Spec | Implementado en | Evidencia |
|---|---|---|
| §3/§4 MODO LIVE (@usuario + $precio, crear/buscar cliente, volver solo) | RPC `vl_agregar_item` + `LiveView.js` | migración 20261013:337-470 (buscar/crear cliente, LIVE del día, proceso activo, item, saldo, prendas_en_bolsa, alerta); UI `src/ventas-live/ui/LiveView.js` |
| §5 Cliente (tiktok, nombre, WA, ciudad, comuna, dirección, entrega_preferida, notas, estado/categoría) | `vl_clientes` | 20261013:49-74 (tiktok normalizado único por tenant; entrega_preferida; categoría 'nuevo/confiable/problematico/bloqueado' manual) |
| §6 Cuenta corriente (historial vs saldo actual) | Saldo SIEMPRE derivado: `vl_saldo_proceso` = Σ(precio−abonado) de items 'adjudicada'; historial = vl_items/vl_pagos acumulados | 20261013:255-266 |
| §7 Prendas sin inventario previo (descripción opcional) | `vl_items` (descripcion default '', precio, abonado, estado) | 20261013:132-153 |
| §8 WhatsApp PASOS 1-7 (saludo→pedir @→identificar+asociar WA→listar+total→envío/presencial→ciudad/comuna/dirección→total+datos pago→ESPERANDO PAGO) | Cerebro del bot `vl_wa_conversacion_avanzar` + `vl_wa_chats` (estados nuevo/esperando_tiktok/esperando_tipo_entrega/esperando_ciudad/comuna/direccion/listo) + `vl_wa_mensajes` | 20261019:65-119, 138+; fix 20261020:13 |
| §8 (cont.) RECIBIR mensaje por webhook y ENVIAR respuesta | **NO IMPLEMENTADO** (Edge Function ausente; `vl_config.wa_phone_id/wa_token/wa_verify_token/wa_estado` ya existen para eso) | supabase/functions/ solo tiene mercadopago-*; 20261019:4-6 "la tubería/webhook llega en un ciclo posterior" |
| §9 Automatización de datos (respuestas guardan BD) | El cerebro escribe cliente (whatsapp/ciudad/comuna/direccion/entrega_preferida) y proceso | 20261019:134-136 (comentario) |
| §10 Estados del proceso (13 estados) | `vl_procesos.estado` — CHECK idéntico a la spec | 20261013:99-114 (esperando_whatsapp, identificando_cliente, esperando_pago, pago_parcial, pagara_presencial, pagado, acumulando, listo_preparar, envio_programado, envio_proceso, entrega_presencial, completado, no_pago_liberado) |
| §11 Clientes que no contactan (tiempo transcurrido, mantener/contactar/liberar/marcar) | `vl_config.dias_reserva` (default 3), `vl_liberar_items` (motivo 'liberado'), panel con edad (CSS .vl-edad-warn), categoría manual | 20261013:215-221, 1038; ventas-live.html:235 |
| §12 Bloqueos / historial de comportamiento, NUNCA automático, alerta en LIVE | Alerta ⚠️ en MODO LIVE si categoría problematico/bloqueado con nº reservas sin concretar; categoría siempre manual | `vl_agregar_item` 20261013:431-449; `LiveView.js:195-201,236-241` |
| §13 Confirmación de pagos (completo/parcial/presencial/no confirmado) + actualizar historial/saldo/estado | `vl_confirmar_pago` (imputación FIFO `vl_imputar_pago`; estados: pago_parcial/pagado/pagara_presencial/acumulando/entrega_presencial) | 20261013:290-336, 751-841 |
| §13 (cont.) Comprobante recibido [VER IMAGEN] | **NO IMPLEMENTADO** — vl_pagos no tiene columna de comprobante | 20261013:156-165 |
| §14 Clientes que siguen comprando (ACUMULANDO) | Estado 'acumulando'; 1 proceso activo por cliente (índice único parcial) | 20261013:124-126; vl_decidir_entrega 20261013:885-886 |
| §15 Decisión post-pago (4 opciones) | `vl_decidir_entrega`: 'acumular' / 'despues' / 'enviar_ahora' / 'fecha' | 20261013:843-914 |
| §16 Envíos programados (fecha, dashboard HOY/MAÑANA/PRÓXIMOS) | `vl_envios.fecha_programada` + `vl_envios_pendientes` agrupado | 20261013:176-195; 20261014:362; fix 20261016 |
| §17 Bolsa física por @usuario, cantidad prendas guardadas | 1 proceso activo/cliente + `prendas_en_bolsa` (items adjudicada+pagada) | 20261013:462-465 |
| §18 Panel de procesos activos con contadores | `vl_panel_procesos` (grupos con acciones) + chips UI | 20261014:264; fix 20261015; `ProcesosView.js` |
| §19 Dashboard principal | `vl_dashboard` | 20261014:438 |
| §20 Historial del cliente (ficha completa) | `vl_ficha_cliente` (compras/pagos/prendas/saldo/proceso) | 20261014:160; fix 20261017:11; `ClientesView.js` |
| §21 Envíos: empresas + datos para copiar | `vl_envios.empresa` CHECK ('blue_express','paket','chilexpress','starken','otra') + UI con copiar (.vl-datos-copy) | 20261013:181; ventas-live.html:315; `EnviosView.js` |
| §22 Confirmación del envío (empresa + tracking) | `vl_crear_envio` (empresa/tracking opcionales) | 20261013:916-977 |
| §23 Lista de tareas de envíos | `vl_envios_pendientes` (tareas HOY/MAÑANA/PRÓXIMOS, preparar/crear) | 20261014:362 + fix 20261016; `EnviosView.js` |
| §24 Finanzas (ingresos/inversiones/gastos/resultados; ganancia estimada vs flujo de caja) | `vl_gastos` (inversion/gasto) + `vl_finanzas_resumen` (ganancia_estimada = recibido−inversión−gastos; flujo_caja = recibido−gastos) | 20261013:198-212; 20261014:538-609 |
| §25 Automatizaciones | `vl_agregar_item`, `vl_wa_conversacion_avanzar`, `vl_confirmar_pago` (FIFO), `vl_decidir_entrega`, `vl_crear_envio` | — |
| §26/§27 Velocidad y UX durante LIVE | Pantalla LIVE con preview de cliente, alertas, deshacer (vl_eliminar_item) y auto-reset | LiveView.js; git log 4286cde; 20261013:1151 |
| §28 Entidades conceptuales | 1:1 con vl_clientes, vl_lives, vl_procesos(+items como movimientos), vl_pagos, vl_envios, vl_gastos | — |

---

## 3. Análisis de completitud de la especificación

### 3.1 Brechas reales (spec pide algo que el código no tiene)

- **G1 — Tubería WhatsApp (spec §8, crítico para el flujo automático).** No existe Edge Function que
  reciba el webhook de Meta Cloud API (GET verify_token / POST messages), resuelva tenant por
  wa_phone_id, llame `vl_wa_conversacion_avanzar` y envíe la respuesta por Graph API. Sin esto el
  bot es solo lógica. Es el "Ciclo 10" anunciado en 20261019:123.
- **G2 — Comprobante de pago (spec §13).** No hay columna ni storage para la imagen del comprobante.
  (Nota: si el cliente lo envía por WhatsApp como foto, G1 debe además descargar media de Meta.)
- **G3 — Ganancia estimada (spec §24).** Hoy = recibido − inversión − gastos (subestima cuando hay
  ventas devengadas sin cobrar). Flujo de caja está bien. Decisión: devengado vs recibido.

### 3.2 Mejoras opcionales (la spec los lista como "datos posibles" o "puede")

- **G4 — Etiquetas** en cliente (spec §5 las lista; no hay columna; existe `notas` libre).
- **G5 — Destinatario de envío** (spec §8 paso 5: "nombre del destinatario, teléfono si es
  necesario"): hoy los datos de envío (ciudad/comuna/dirección) se guardan en el cliente y se asume
  que el destinatario es el propio cliente.
- **G6 — "⚠️ POSIBLE CLIENTE PROBLEMÁTICO" automático** (spec §12): la spec dice que la app *puede*
  mostrar la advertencia con patrón de reservas sin concretar. La implementación solo alerta cuando
  el admin YA marcó la categoría problematico/bloqueado; no sugiere el patrón automáticamente
  (respeta el "NUNCA bloquear automático", pero no muestra el "posible").

### 3.3 Ambigüedades / decisiones de negocio que la spec NO resuelve (hay que preguntar)

- **D1 — Roles**: la spec dice "los vendedores" (plural) operan el LIVE, pero `vl_agregar_item` exige
  `is_admin()`. ¿Un solo operador admin o varios usuarios con rol vendedor por tenant?
- **D2 — Costo de envío**: ¿lo paga el cliente (sumar al saldo, campo `costo_envio` en vl_envios) o
  lo asume el negocio (registrar como gasto)? La spec solo contempla "envíos asumidos" como gasto.
- **D3 — Moneda/precisión**: CLP entero ($8.000). numeric(10,2) soporta decimales; formateo del bot
  ya es CLP sin decimales (`vl_wa_fmt_monto`). Confirmar que nunca habrá decimales.
- **D4 — Prenda liberada (spec §10 🔴)**: ¿se puede revender y registrar esa reventa en el mismo
  cliente/otro? Hoy la liberación es irreversible en el item (estado 'liberada', histórico).
- **D5 — Cambios/devoluciones post-entrega**: no contemplados (ok para v1, confirmar).
- **D6 — Varios destinos por cliente acumulador**: 1 `vl_envios` por proceso (UNIQUE proceso_id);
  un acumulador que quiera partir su bolsa en 2 envíos no está soportado. Aceptable para v1.
- **D7 — Notificación al admin**: cuando un cliente escribe por WA o paga, ¿basta el panel
  (refresco) o se quiere realtime/notificación?
- **D8 — Alcance del entregable**: ¿este análisis aplica a un cliente/tenant nuevo (crear workspace
  `ventas_live` + plan `vl_free`, cero código nuevo) o a una fase 3 del producto actual?

---

## 4. Arquitectura técnica

### 4.1 Stack y plataforma (ya en producción)

- Frontend: HTML/CSS/JS vanilla, bundle con build.js → `dist/app.js?v=N` + `dist/legacy.js?v=N`
  (cache-bust manual, CSP con hashes; ver skills vercel-deployment/webapp-security-hardening).
- Backend: Supabase (Postgres + PostgREST). Todo el dominio VL se expone por **RPCs SECURITY
  DEFINER** (sin acceso directo a tablas: REVOKE ALL + RLS ON sin policies + GRANT EXECUTE solo a
  authenticated; `service_role` únicamente dentro de Edge Functions).
- Multi-tenant por proyecto: `tenants.proyecto IN ('reservas','ventas_live')`; helpers RLS
  `get_user_tenant_id()` (reservas) y `get_vl_tenant_id()` (VL); `user_roles (user_id, tenant_id)`
  con índice UNIQUE NULLS NOT DISTINCT (multi-workspace); planes: `vl_free` (sin precio aún).
- Edge Functions existentes: mercadopago-webhook, create-preference, create-preapproval,
  cancelar-suscripcion (+ `_shared`). **No hay ninguna de WhatsApp.**
- Hosting: Vercel (auto-alias agenda-pro-red), dominio organifypyme.com, rewrite /p/:slug.
- Dinero: `numeric(10,2)`, saldo NUNCA almacenado (derivado), imputación FIFO.

### 4.2 Componentes del producto Ventas Live

```
ventas-live.html (shell + navegación LIVE/Procesos/Clientes/Envíos/Finanzas)
└─ src/ventas-live/
   ├─ domain/vlApi.js            → envoltura de RPCs (única puerta del front)
   └─ ui/
      ├─ VentasLiveView.js       → orquestador (workspace, tabs, permisos)
      ├─ LiveView.js             → MODO LIVE (@usuario + $precio + preview + alerta + deshacer)
      ├─ ProcesosView.js         → panel de procesos por estado (chips + acciones)
      ├─ ClientesView.js         → búsqueda + ficha (vl_ficha_cliente)
      ├─ EnviosView.js           → tareas HOY/MAÑANA/PRÓXIMOS + copiar datos + crear envío
      ├─ FinanzasView.js         → resumen + gastos
      ├─ accionesProceso.js      → transiciones (pago, entrega, liberar…)
      └─ vlModales.js            → modales reutilizables
DB (Supabase)  →  vl_clientes / vl_lives / vl_procesos / vl_items / vl_pagos /
                  vl_envios / vl_gastos / vl_config / vl_wa_chats / vl_wa_mensajes
                  + ~34 RPCs vl_* (escritura 20261013, lectura 20261014-17, bot 20261019-20)
[FUTURO] supabase/functions/wa-webhook → tubería Meta Cloud API (G1)
```

### 4.3 Patrones obligatorios (convenciones del repo)

1. Migraciones: prefijo YYYYMMDD_*, cronológicas, lineales, idempotentes, **sin DO $$**, con
   `NOTIFY pgrst, 'reload schema'` al final; aplicar con `supabase db push --linked`.
2. Toda función de negocio: SECURITY DEFINER, `SET search_path TO 'public'`, valida tenant
   (`get_vl_tenant_id()`) y rol (`is_admin()`) en el cuerpo, devuelve `{ok:bool, error?}`.
3. RLS ON + sin policies en tablas vl_* + REVOKE ALL; solo GRANT EXECUTE de funciones.
4. Bot: `vl_wa_conversacion_avanzar(p_tenant_id, p_wa_id, p_texto, p_tipo)` NO usa JWT (tenant
   explícito resuelto por el webhook); autorización por `service_role` desde la Edge Function.
5. Cash: números con `vl_wa_fmt_monto` ($18.000); no exponer tokens (wa_token) al front: la Edge
   Function lee vl_config con service_role y nunca devuelve el token.

---

## 5. Modelo de base de datos

### 5.1 Entidades (ya creadas por 20261013 + 20261019)

```
tenants (proyecto 'ventas_live') ─┬─< vl_clientes  (tiktok_user único por tenant, normalizado)
                                  ├─< vl_lives     (etiqueta, abierto_en, cerrado_en)
                                  ├─< vl_procesos  (cliente_id, estado[13], motivo_cierre,
                                  │                 creado/cerrado/updated)  1 ACTIVO por cliente
                                  ├─< vl_items     (proceso_id→, live_id→, descripcion, precio,
                                  │                 abonado≤precio, estado adjudicada/pagada/liberada/entregada)
                                  ├─< vl_pagos     (proceso_id→, monto>0, metodo, nota,
                                  │                 confirmado_por/en)          [falta comprobante: G2]
                                  ├─< vl_envios    (proceso_id→ UNIQUE, tipo envio/presencial,
                                  │                 empresa[blue_express,paket,chilexpress,starken,otra],
                                  │                 tracking, fecha_programada, estado pendiente/programado/
                                  │                 en_proceso/entregado/cancelado)
                                  ├─< vl_gastos    (tipo inversion/gasto, concepto, monto, fecha)
                                  ├─ vl_config     (PK tenant_id: datos_pago, dias_reserva 1-60,
                                  │                 whatsapp_negocio, wa_phone_id, wa_token, wa_verify_token,
                                  │                 wa_estado desconectado/conectado)
                                  └─< vl_wa_chats  (tenant_id+wa_id UNIQUE, cliente_id→, estado
                                                    nuevo/esperando_tiktok/esperando_tipo_entrega/
                                                    esperando_ciudad/esperando_comuna/esperando_direccion/listo)
                                       └─< vl_wa_mensajes (direction in/out, tipo, body, log inmutable)
```

### 5.2 Invariantes clave (reglas de negocio en datos)

- Saldo pendiente = Σ(precio − abonado) sobre items `'adjudicada'` — derivado, nunca almacenado.
- 1 proceso activo por cliente: índice único parcial `(cliente_id) WHERE cerrado_en IS NULL`.
- Al pagar: imputación FIFO por proceso (`vl_imputar_pago`) y el item pasa a 'pagada' cuando
  abonado ≥ precio (20261013:314).
- 1 vl_envios por proceso (UNIQUE proceso_id) → D6.
- Categoría de cliente SIEMPRE manual (spec §12); el código solo informa, nunca la cambia.

### 5.3 Deltas propuestos (según aprobación)

- G2: `ALTER TABLE vl_pagos ADD COLUMN comprobante_url text NOT NULL DEFAULT ''` + bucket
  `vl-comprobantes` (privado, lectura firmada) + subida con la sesión del admin (patrón de
  supabase-storage-setup.sql existente).
- G4 (opcional): `vl_clientes.etiquetas text[] NOT NULL DEFAULT '{}'`.
- G5 (opcional): columnas `destinatario_nombre`, `destinatario_telefono` en vl_clientes (o en
  vl_envios si aplica solo al envío actual).
- D2 (si aplica): `vl_envios.costo_envio numeric(10,2) NOT NULL DEFAULT 0` + regla de cobro.

---

## 6. Flujos de estados

### 6.1 Máquina de estados del proceso (vl_procesos, 13 estados)

```
esperando_whatsapp ──(WA identifica cliente / admin marca)──▶ identificando_cliente
identificando_cliente ──(bot completa datos y muestra total+pago)──▶ esperando_pago
esperando_pago ──(confirmar pago completo)──▶ pagado
esperando_pago ──(pago parcial)──▶ pago_parcial ──(resto)──▶ pagado
esperando_whatsapp / identificando_cliente / esperando_pago / pago_parcial
                ──(admin: pagará presencial)──▶ pagara_presencial
pagado / acumulando ──(vl_decidir_entrega)──▶
        'acumular' → acumulando · 'despues' → pagado/acumulando
        'enviar_ahora'(envio) → listo_preparar · (presencial) → entrega_presencial
        'fecha' → envio_programado (+ vl_envios programado con fecha)
listo_preparar ──(admin: ENVÍO CREADO, vl_crear_envio)──▶ envio_proceso
envio_programado / envio_proceso / entrega_presencial ──(vl_marcar_entregado)──▶ completado (motivo 'completado')
cualquier estado con saldo ──(vl_liberar_items)──▶ no_pago_liberado (motivo 'liberado'/'cancelado')
Al completar/liberar el proceso se cierra; una compra futura abre uno nuevo (historial de
confiabilidad = procesos cerrados).
```

Transiciones validadas en SQL: vl_marcar_esperando_pago exige estado ∈
{esperando_whatsapp, identificando_cliente, pagara_presencial} (20261013:702); vl_marcar_pagara_presencial
∈ {esperando_whatsapp, identificando_cliente, esperando_pago, pago_parcial} (:736); vl_decidir_entrega
solo con proceso pagado y saldo 0 (:874-881).

### 6.2 Flujo WhatsApp (spec §8) — implementado como máquina en vl_wa_chats

```
nuevo → (cliente escribe) → saludo → esperando_tiktok
esperando_tiktok → @usuario → busca/crea... asocia wa_id→cliente, guarda whatsapp,
                    lista prendas + total → esperando_tipo_entrega
esperando_tipo_entrega → 'envío' → esperando_ciudad → esperando_comuna → esperando_direccion
                       → 'presencial' → (salta datos) 
→ muestra total + datos de pago (vl_config.datos_pago) → proceso a esperando_pago → estado 'listo'
```
Nota: el paso "identificando_cliente" del proceso lo setea el bot al encontrar al cliente.

### 6.3 Flujo LIVE → cierre (vista de pájaro)

LIVE (@u + $) → vl_agregar_item (cliente/proceso/live/item/saldo/prendas en bolsa/alerta) →
ESPERANDO WHATSAPP → [WA: identifica → tipo de entrega → datos → total + pago] → ESPERANDO PAGO →
admin confirma (completo/parcial/presencial) → PAGADO/ACUMULANDO → decisión entrega → envío o
entrega → COMPLETADO. No-contacto: días_reserva → admin mantiene/libera (no_pago_liberado)/marca.

---

## 7. Plan de implementación (por fases, primera versión funcional primero)

> El producto v1+v2 ya está desplegado (commits del 2026-09-07, app.js?v=68). El plan cierra las
> brechas reales SIN funciones innecesarias. Si el objetivo es un cliente nuevo: D8 → Fase 0 y nada
> de código (todo el dominio es multi-tenant por diseño).

**Fase 0 — Puesta en marcha de un tenant VL (si aplica a cliente nuevo)**
- Crear tenant `proyecto='ventas_live'` + plan `vl_free` + usuario admin (user_roles multi-workspace).
- Validar: MODO LIVE registra venta; panel/dashboard con datos; config nombre+WA.
- Criterio: el dueño ve su workspace VL y puede operar. Validación: UI real + db query --linked.

**Fase 1 — Cierre de brechas del flujo automático (MVP completo de la spec)**
1. Edge Function `wa-webhook` (nueva, patrón de mercadopago-webhook + skill whatsapp-business-platform):
   - GET: verificación handshake con `wa_verify_token` de vl_config del tenant (por phone_id).
   - POST: mensajes entrantes; resolver tenant por `wa_phone_id`; llamar
     `vl_wa_conversacion_avanzar(tenant, wa_id, texto)`; enviar respuesta con Graph API
     (messages endpoint, token desde vl_config — nunca al front); log en vl_wa_mensajes.
   - (v1.1) Si el mensaje es imagen y el estado del chat es esperando comprobante → descargar media
     de Meta y guardarla como comprobante (G1+G2 combinados) — opcional si G2 va manual primero.
2. Comprobante manual mínimo (G2): columna `comprobante_url` en vl_pagos + subida en el modal de
   confirmación de pago + "[VER IMAGEN]" en la ficha/panel (patrón storage existente).
3. Fix G3 (si el negocio confirma devengado): `ganancia_estimada = ventas_total − inversión − gastos`
   (mantener `flujo_caja = recibido − gastos`).
4. UI de conexión WhatsApp en el workspace (estado conectado/desconectado, phone_id, verify token,
   link al webhook) — reutilizar el modal de config existente.
- Criterios de aceptación F1: (a) un mensaje de WhatsApp real recorre saludo→@tiktok→tipo de
  entrega→datos→total→esperando_pago sin intervención manual; (b) comprobante visible en la
  confirmación; (c) finanzas coherentes. Validación: E2E Playwright (skill playwright-e2e-validation)
  + pruebas reales con el número WABA de prueba + `supabase db push` y revisión de migración única.
- Orden técnico estricto: 1 migración SQL (2026xxxx_ventas_live_fase3_wa_tuberia.sql: columna
  comprobante + fix G3 si aplica) → edge function → build.js → deploy Vercel (ritual completo:
  node build.js ANTES, re-aliasear TODOS los custom domains) → pruebas.

**Fase 2 — Opcional (solo si el negocio lo pide)**
- G4 etiquetas, G5 destinatario, G6 sugerencia "posible problemático" (solo visual, nunca
  automática), D7 realtime/notificación al admin, D2 costo de envío.

**No hacer (explícitamente fuera de alcance v1):** inventario previo, códigos por prenda, fotos
obligatorias, IA en el bot, integración con empresas de transporte, catálogo.

---

## 8. Riesgos y verificaciones pendientes

1. **G1 es el único bloqueante real** del flujo "100% automático" de la spec §8/§9; el resto del
   sistema funciona sin él (confirmación manual de pago ya operativa).
2. `wa_token` (token permanente de Meta) vive en vl_config: la Edge Function debe leerlo con
   service_role; la UI solo marca estado. No exponer en respuestas de RPC existentes (vl_workspace_info
   debe ocultarlo — verificar en Ciclo 2).
3. Verificaciones UI pendientes de validación visual: botón "contactar manualmente" (wa.me) en
   panel/ficha, botón "abrir página de envío" por empresa, y auto-reset del form LIVE.
4. Envío de mensajes proactivos (recordatorio a no-contactados) requiere plantillas aprobadas por
   Meta (limitación de la plataforma, no del código) — fuera de v1 si el cliente no tiene plantilla.
5. Índice MCP alternativo `mi-agenda-web` está desactualizado; usar siempre el key
   `home-branscott-proyectos-...-Copiar-13`.

---

## 9. Criterios de aceptación de este entregable

- [x] Spec analizada sección por sección contra código real (archivo:línea), no contra el grafo.
- [x] Arquitectura técnica documentada (estado actual + objetivo).
- [x] Modelo de base de datos documentado (entidades, invariantes, deltas).
- [x] Flujos de estados documentados (máquina + transiciones validadas en SQL).
- [x] Plan de implementación priorizado (primera versión funcional, sin funciones innecesarias).
- [x] Brechas y ambigüedades de la spec identificadas (G1-G6, D1-D8).
- [ ] Decisión del dueño sobre D1-D8 y aprobación de Fase 1 → siguiente ciclo.
