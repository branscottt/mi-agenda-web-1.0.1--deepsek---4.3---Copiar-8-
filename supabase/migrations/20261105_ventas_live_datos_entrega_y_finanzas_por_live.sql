-- ============================================================
-- 20261105 — Ventas Live: finanzas por LIVE + datos de entrega
-- ============================================================
-- Ciclo 2: la ganancia se puede mirar LIVE por LIVE (antes todo era un
--          total global, y como se invierte por live no se sabía cuál dejó
--          plata). Se agrega vl_gastos.live_id (opcional) y el desglose.
-- Ciclo 3: lo que el cliente escribe para el envío (nombre, comuna,
--          dirección, teléfono, correo) se guarda y se puede ver/editar.
--          El dato crudo ya se guardaba en vl_clientes.datos_envio, pero
--          (a) solo cuando el texto traía correo/teléfono o ≥3 palabras con
--          palabra clave — "en pudahuel" se perdía — y (b) ningún panel lo
--          mostraba.
-- Es ADITIVO: no borra datos ni cambia estados de pedidos.

-- ============================================================
-- 1) FINANZAS POR LIVE
-- ============================================================

ALTER TABLE public.vl_gastos
    ADD COLUMN IF NOT EXISTS live_id uuid REFERENCES public.vl_lives(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vl_gastos_live ON public.vl_gastos (live_id);

-- Registrar inversión/gasto, ahora con LIVE opcional.
-- Se DROPea la firma vieja para no dejar dos candidatas (sobrecarga ambigua).
DROP FUNCTION IF EXISTS public.vl_agregar_gasto(text, text, numeric, date);

CREATE OR REPLACE FUNCTION public.vl_agregar_gasto(
    p_tipo text,
    p_concepto text,
    p_monto numeric,
    p_fecha date DEFAULT CURRENT_DATE,
    p_live_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_gasto_id uuid;
    v_live_ok boolean;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    IF p_tipo NOT IN ('inversion', 'gasto') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tipo inválido (inversion | gasto)');
    END IF;
    IF p_concepto IS NULL OR btrim(p_concepto) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El concepto es requerido');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Monto inválido');
    END IF;

    -- El LIVE (si viene) tiene que ser de este mismo espacio.
    IF p_live_id IS NOT NULL THEN
        SELECT true INTO v_live_ok FROM public.vl_lives
        WHERE id = p_live_id AND tenant_id = v_tenant;
        IF NOT COALESCE(v_live_ok, false) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Ese LIVE no es de tu espacio');
        END IF;
    END IF;

    INSERT INTO public.vl_gastos (tenant_id, tipo, concepto, monto, fecha, live_id)
    VALUES (v_tenant, p_tipo, btrim(p_concepto), p_monto, COALESCE(p_fecha, CURRENT_DATE), p_live_id)
    RETURNING id INTO v_gasto_id;

    RETURN jsonb_build_object('ok', true, 'gasto_id', v_gasto_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vl_agregar_gasto(text, text, numeric, date, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_agregar_gasto(text, text, numeric, date, uuid) TO authenticated;

-- Resumen de finanzas: se mantienen TODAS las claves de antes (ingresos,
-- inversiones, gastos, resultado, ultimos_gastos) y se agregan:
--   lives            -> una entrada por LIVE (prendas, ventas, cobrado,
--                       pendiente, invertido, gastos, ganancia)
--   sin_live         -> lo que quedó sin LIVE asignado (para que cuadre)
--   lives_disponibles-> para el selector del formulario
CREATE OR REPLACE FUNCTION public.vl_finanzas_resumen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_ventas_total numeric;
    v_ventas_mes numeric;
    v_recibido_total numeric;
    v_recibido_mes numeric;
    v_pendiente numeric;
    v_inversion_total numeric;
    v_inversion_mes numeric;
    v_gastos_total numeric;
    v_gastos_mes numeric;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    -- VENTAS = prendas que sí se vendieron. Las liberadas quedan fuera.
    SELECT COALESCE(SUM(precio), 0) INTO v_ventas_total
    FROM public.vl_items
    WHERE tenant_id = v_tenant AND estado <> 'liberada';

    SELECT COALESCE(SUM(precio), 0) INTO v_ventas_mes
    FROM public.vl_items
    WHERE tenant_id = v_tenant AND estado <> 'liberada'
      AND creado_en >= date_trunc('month', now());

    SELECT COALESCE(SUM(monto), 0) INTO v_recibido_total FROM public.vl_pagos WHERE tenant_id = v_tenant;
    SELECT COALESCE(SUM(monto), 0) INTO v_recibido_mes FROM public.vl_pagos
    WHERE tenant_id = v_tenant AND confirmado_en >= date_trunc('month', now());

    SELECT COALESCE(SUM(public.vl_saldo_proceso(pr.id)), 0) INTO v_pendiente
    FROM public.vl_procesos pr
    WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL;

    SELECT COALESCE(SUM(monto), 0), COALESCE(SUM(monto) FILTER (WHERE fecha >= date_trunc('month', CURRENT_DATE)::date), 0)
    INTO v_inversion_total, v_inversion_mes
    FROM public.vl_gastos WHERE tenant_id = v_tenant AND tipo = 'inversion';

    SELECT COALESCE(SUM(monto), 0), COALESCE(SUM(monto) FILTER (WHERE fecha >= date_trunc('month', CURRENT_DATE)::date), 0)
    INTO v_gastos_total, v_gastos_mes
    FROM public.vl_gastos WHERE tenant_id = v_tenant AND tipo = 'gasto';

    RETURN jsonb_build_object(
        'ok', true,
        'ingresos', jsonb_build_object(
            'ventas_total', v_ventas_total,
            'ventas_mes', v_ventas_mes,
            'recibido_total', v_recibido_total,
            'recibido_mes', v_recibido_mes,
            'pendiente', v_pendiente
        ),
        'inversiones', jsonb_build_object('total', v_inversion_total, 'mes', v_inversion_mes),
        'gastos', jsonb_build_object('total', v_gastos_total, 'mes', v_gastos_mes),
        'resultado', jsonb_build_object(
            'ganancia_estimada', v_recibido_total - v_inversion_total - v_gastos_total,
            'flujo_caja', v_recibido_total - v_gastos_total
        ),

        -- ── Desglose por LIVE (Ciclo 2) ──
        -- cobrado = suma de abonado de las prendas de ese LIVE (dato exacto por
        -- prenda, no se prorratean pagos). ganancia = cobrado − invertido − gastos.
        'lives', COALESCE((
            SELECT jsonb_agg(to_jsonb(t) - 'orden' ORDER BY t.orden DESC NULLS LAST)
            FROM (
                SELECT l.id AS live_id,
                       COALESCE(NULLIF(l.etiqueta, ''), 'LIVE sin nombre') AS etiqueta,
                       COALESCE(l.cerrado_en IS NULL, false) AS abierto,
                       to_char(l.abierto_en, 'YYYY-MM-DD') AS fecha,
                       COALESCE(v.prendas, 0)  AS prendas,
                       COALESCE(v.ventas, 0)   AS ventas,
                       COALESCE(v.cobrado, 0)  AS cobrado,
                       COALESCE(v.ventas, 0) - COALESCE(v.cobrado, 0) AS pendiente,
                       COALESCE(g.invertido, 0) AS invertido,
                       COALESCE(g.gastos, 0)    AS gastos,
                       COALESCE(v.cobrado, 0) - COALESCE(g.invertido, 0) - COALESCE(g.gastos, 0) AS ganancia,
                       l.abierto_en AS orden
                FROM public.vl_lives l
                LEFT JOIN LATERAL (
                    SELECT count(*) AS prendas, SUM(i.precio) AS ventas, SUM(i.abonado) AS cobrado
                    FROM public.vl_items i
                    WHERE i.live_id = l.id AND i.estado <> 'liberada'
                ) v ON true
                LEFT JOIN LATERAL (
                    SELECT SUM(x.monto) FILTER (WHERE x.tipo = 'inversion') AS invertido,
                           SUM(x.monto) FILTER (WHERE x.tipo = 'gasto')     AS gastos
                    FROM public.vl_gastos x
                    WHERE x.live_id = l.id
                ) g ON true
                WHERE l.tenant_id = v_tenant
            ) t
        ), '[]'::jsonb),

        -- Lo que NO tiene LIVE asignado (prendas viejas o sin LIVE abierto,
        -- e inversiones/gastos sin LIVE). Se muestra aparte para que el total
        -- general cuadre con la suma de las filas.
        'sin_live', jsonb_build_object(
            'prendas',  COALESCE((SELECT count(*) FROM public.vl_items i
                                  WHERE i.tenant_id = v_tenant AND i.live_id IS NULL AND i.estado <> 'liberada'), 0),
            'ventas',   COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                                  WHERE i.tenant_id = v_tenant AND i.live_id IS NULL AND i.estado <> 'liberada'), 0),
            'cobrado',  COALESCE((SELECT SUM(i.abonado) FROM public.vl_items i
                                  WHERE i.tenant_id = v_tenant AND i.live_id IS NULL AND i.estado <> 'liberada'), 0),
            'invertido', COALESCE((SELECT SUM(x.monto) FROM public.vl_gastos x
                                   WHERE x.tenant_id = v_tenant AND x.live_id IS NULL AND x.tipo = 'inversion'), 0),
            'gastos',    COALESCE((SELECT SUM(x.monto) FROM public.vl_gastos x
                                   WHERE x.tenant_id = v_tenant AND x.live_id IS NULL AND x.tipo = 'gasto'), 0)
        ),

        'lives_disponibles', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'live_id', l.id,
                       'etiqueta', COALESCE(NULLIF(l.etiqueta, ''), 'LIVE sin nombre'),
                       'abierto', (l.cerrado_en IS NULL),
                       'fecha', to_char(l.abierto_en, 'YYYY-MM-DD')
                   ) ORDER BY l.abierto_en DESC)
            FROM (SELECT * FROM public.vl_lives WHERE tenant_id = v_tenant
                  ORDER BY abierto_en DESC LIMIT 30) l
        ), '[]'::jsonb),

        'ultimos_gastos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'gasto_id', g.id, 'tipo', g.tipo, 'concepto', g.concepto,
                'monto', g.monto, 'fecha', g.fecha, 'live_id', g.live_id,
                'live_etiqueta', (SELECT COALESCE(NULLIF(l2.etiqueta, ''), 'LIVE sin nombre')
                                  FROM public.vl_lives l2 WHERE l2.id = g.live_id)
            ) ORDER BY g.fecha DESC, g.creado_en DESC)
            FROM public.vl_gastos g WHERE g.tenant_id = v_tenant
            LIMIT 50
        ), '[]'::jsonb)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_finanzas_resumen() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_finanzas_resumen() TO authenticated;

-- ============================================================
-- 2) DATOS DE ENTREGA: capturarlos y verlos
-- ============================================================

-- 2.1 Comunas de Chile conocidas (Santiago + principales del país).
--     Sirve para reconocer "en Pudahuel", "vivo en maipú", "soy de viña"…
--     Si la comuna no está en la lista, el texto igual queda guardado crudo
--     en datos_envio y se puede completar a mano en la ficha.
CREATE OR REPLACE FUNCTION public.vl_comuna_chilena(p_texto text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_low text;
    v_c text;
    v_comunas text[] := ARRAY[
        'Estación Central','Pedro Aguirre Cerda','San Pedro de la Paz','Padre Las Casas',
        'Puerto Natales','Puerto Montt','Puerto Varas','Puerto Aysén','Viña del Mar',
        'Villa Alemana','Quinta Normal','Lo Barnechea','Cerro Navia','Independencia',
        'La Cisterna','La Florida','La Granja','La Pintana','La Reina','Las Condes',
        'Lo Espejo','Lo Prado','Quilicura','Recoleta','San Joaquín','San Miguel',
        'San Ramón','San Bernardo','San Antonio','San Fernando','San Felipe','San Carlos',
        'Santa Cruz','Alto Hospicio','Calama','Tocopilla','Chañaral','Copiapó','Vallenar',
        'La Serena','Coquimbo','Ovalle','Illapel','Los Vilos','Vicuña','Quillota',
        'Los Andes','La Calera','Concón','Limache','Cartagena','Casablanca','Quilpué',
        'Rancagua','Machalí','Rengo','Talca','Curicó','Linares','Constitución','Cauquenes',
        'Chillán','Concepción','Talcahuano','Chiguayante','Coronel','Lota','Tomé',
        'Los Ángeles','Cañete','Curanilahue','Temuco','Villarrica','Angol','Pucón',
        'Nueva Imperial','Valdivia','La Unión','Río Bueno','Osorno','Frutillar',
        'Castro','Ancud','Quellón','Coyhaique','Punta Arenas','Arica','Iquique',
        'Antofagasta','Maipú','Ñuñoa','Peñalolén','Providencia','Pudahuel','Macul',
        'Maule','Puente Alto','Colina','Lampa','Buin','Melipilla','Talagante','Peñaflor',
        'Curacaví','Isla de Maipo','El Monte','Cerrillos','Huechuraba','Conchalí',
        'El Bosque','Santiago','Valparaíso','Renca','Vitacura','Quintero','Puchuncaví'
    ];
BEGIN
    IF COALESCE(btrim(p_texto), '') = '' THEN
        RETURN '';
    END IF;
    -- Se pasan a minúsculas sin acentos y SIN puntuación (así "…1234, Pudahuel,"
    -- también cuenta como la comuna Pudahuel).
    v_low := ' ' || regexp_replace(translate(lower(btrim(p_texto)), 'áéíóúüñ', 'aeioun'),
                                   '[^a-z0-9]+', ' ', 'g') || ' ';
    FOR i IN 1..array_length(v_comunas, 1) LOOP
        v_c := v_comunas[i];
        IF position(' ' || regexp_replace(translate(lower(v_c), 'áéíóúüñ', 'aeioun'),
                                          '[^a-z0-9]+', ' ', 'g') || ' ' IN v_low) > 0 THEN
            RETURN v_c;
        END IF;
    END LOOP;
    RETURN '';
END;
$$;

-- 2.2 Parser de datos de entrega escritos por el cliente.
--     Devuelve solo lo que puede reconocer con patrones claros (nunca inventa).
CREATE OR REPLACE FUNCTION public.vl_datos_entrega_de_texto(p_texto text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_txt text := btrim(COALESCE(p_texto, ''));
    v_low text;
    v_correo text;
    v_tel text;
    v_comuna text;
    v_dir text;
    v_nombre text;
    v_lineas text[];
    v_l1 text;
    v_palabras int;
BEGIN
    IF v_txt = '' THEN
        RETURN jsonb_build_object('nombre', '', 'comuna', '', 'direccion', '',
                                  'correo', '', 'telefono', '');
    END IF;
    v_low := translate(lower(v_txt), 'áéíóúüñ', 'aeioun');

    -- Correo
    v_correo := COALESCE(substring(v_txt from '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'), '');

    -- Teléfono chileno (+56 9 xxxx xxxx / 9 xxxx xxxx) o internacional
    v_tel := COALESCE(substring(
        regexp_replace(v_txt, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', ' ', 'g')
        from '\+?56?[ \-.]?9[ \-.]?[0-9]{4}[ \-.]?[0-9]{4}|\+[0-9]{8,15}'), '');

    -- Comuna conocida
    v_comuna := public.vl_comuna_chilena(v_txt);

    -- Dirección: "av. Los Aromos 1234", "calle ...", "pasaje ...", o "Nombre 1234"
    v_dir := COALESCE(substring(v_txt from '(?i)((av\.?|avenida|calle|pasaje|psje\.?|villa|pobl\.?|poblacion|población|camino|ruta|depto|dpto|block|blk)[ ]+[^\n,;]{3,70})'), '');
    IF v_dir = '' THEN
        v_dir := COALESCE(substring(v_txt from '(?i)(([a-záéíóúñ.]{3,}([ ]+[a-záéíóúñ.]{2,}){0,3})[ ]+[0-9]{1,5})'), '');
        -- Que no sea un teléfono ni el propio correo
        IF v_dir <> '' AND (v_dir = v_tel OR position('@' in v_dir) > 0) THEN
            v_dir := '';
        END IF;
    END IF;

    -- Nombre explícito: "me llamo X", "mi nombre es X", "nombre: X", "soy X"
    v_nombre := COALESCE(substring(v_low from 'me llamo[ ]+([a-z]{2,}([ ]+[a-z]{2,}){0,3})'), '');
    IF v_nombre = '' THEN
        v_nombre := COALESCE(substring(v_low from 'mi nombre es[ ]+([a-z]{2,}([ ]+[a-z]{2,}){0,3})'), '');
    END IF;
    IF v_nombre = '' THEN
        v_nombre := COALESCE(substring(v_low from 'nombre[ ]*:[ ]*([a-z]{2,}([ ]+[a-z]{2,}){0,3})'), '');
    END IF;
    IF v_nombre = '' THEN
        v_nombre := COALESCE(substring(v_low from '\msoy[ ]+([a-z]{2,}([ ]+[a-z]{2,}){0,2})'), '');
        -- "soy de X" / "soy del X" / "soy en X" no son nombres
        IF v_nombre ~ '^(de|del|en|la|el|una|un)\M' THEN
            v_nombre := '';
        END IF;
    END IF;
    -- El "nombre" no puede ser una comuna ("soy pudahuel" no es un nombre)
    IF v_nombre <> '' AND public.vl_comuna_chilena(v_nombre) <> '' THEN
        v_nombre := '';
    END IF;
    IF v_nombre <> '' THEN
        v_nombre := initcap(btrim(v_nombre));
    END IF;

    -- La comuna no va dentro de la dirección ("av los aromos 1234 pudahuel")
    IF v_dir <> '' AND v_comuna <> '' THEN
        IF position(translate(lower(v_comuna), 'áéíóúüñ', 'aeioun')
                    IN translate(lower(v_dir), 'áéíóúüñ', 'aeioun')) > 0 THEN
            v_dir := left(v_dir,
                position(translate(lower(v_comuna), 'áéíóúüñ', 'aeioun')
                         IN translate(lower(v_dir), 'áéíóúüñ', 'aeioun')) - 1);
            v_dir := btrim(rtrim(btrim(v_dir), ' ,-'));
        END IF;
    END IF;

    -- Bloque de datos en varias líneas: la primera línea suele ser el nombre
    v_lineas := regexp_split_to_array(v_txt, E'\n');
    IF v_nombre = '' AND array_length(v_lineas, 1) >= 2
       AND (v_correo <> '' OR v_tel <> '' OR v_dir <> '' OR v_comuna <> '') THEN
        v_l1 := btrim(v_lineas[1]);
        v_palabras := array_length(regexp_split_to_array(v_l1, '[ ]+'), 1);
        IF v_palabras BETWEEN 2 AND 4
           AND v_l1 ~ '^[A-Za-zÁÉÍÓÚÑáéíóúñ]+([ ]+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)*$'
           AND public.vl_comuna_chilena(v_l1) = '' THEN
            v_nombre := initcap(lower(v_l1));
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'nombre',    left(btrim(v_nombre), 120),
        'comuna',    left(btrim(v_comuna), 120),
        'direccion', left(btrim(v_dir), 200),
        'correo',    left(btrim(v_correo), 160),
        'telefono',  left(btrim(v_tel), 40)
    );
END;
$$;

-- 2.3 Cada mensaje ENTRANTE del cliente se lee y se guarda lo que traiga.
--     Va por trigger (no dentro del cerebro del bot) para que funcione igual
--     cuando el bot está en silencio o el dueño está atendiendo a mano.
CREATE OR REPLACE FUNCTION public.vl_wa_capturar_datos_entrega()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_cliente uuid;
    v_txt text := btrim(COALESCE(NEW.body, ''));
    v_d jsonb;
    v_nombre text; v_comuna text; v_dir text; v_correo text; v_tel text;
BEGIN
    IF NEW.direction <> 'in' OR v_txt = '' THEN
        RETURN NEW;
    END IF;

    SELECT ch.cliente_id INTO v_cliente
    FROM public.vl_wa_chats ch WHERE ch.id = NEW.chat_id;
    IF v_cliente IS NULL THEN
        RETURN NEW;   -- chat sin cliente vinculado: todavía no hay ficha que completar
    END IF;

    v_d := public.vl_datos_entrega_de_texto(v_txt);
    v_nombre := COALESCE(v_d->>'nombre', '');
    v_comuna := COALESCE(v_d->>'comuna', '');
    v_dir    := COALESCE(v_d->>'direccion', '');
    v_correo := COALESCE(v_d->>'correo', '');
    v_tel    := COALESCE(v_d->>'telefono', '');

    IF v_nombre = '' AND v_comuna = '' AND v_dir = '' AND v_correo = '' AND v_tel = '' THEN
        RETURN NEW;
    END IF;

    UPDATE public.vl_clientes SET
        nombre_real = COALESCE(NULLIF(v_nombre, ''), nombre_real),
        comuna      = COALESCE(NULLIF(v_comuna, ''), comuna),
        direccion   = COALESCE(NULLIF(v_dir, ''), direccion),
        correo      = COALESCE(NULLIF(v_correo, ''), correo),
        contacto    = COALESCE(NULLIF(v_tel, ''), contacto),
        -- Texto crudo, sin repetir el mismo mensaje dos veces.
        datos_envio = LEFT(
            CASE WHEN position(v_txt IN COALESCE(datos_envio, '')) > 0
                 THEN datos_envio
                 ELSE btrim(COALESCE(NULLIF(btrim(COALESCE(datos_envio, '')), '') || ' · ', '') || v_txt)
            END, 1000),
        updated_at  = now()
    WHERE id = v_cliente AND tenant_id = NEW.tenant_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vl_wa_capturar_datos_entrega ON public.vl_wa_mensajes;
CREATE TRIGGER trg_vl_wa_capturar_datos_entrega
    AFTER INSERT ON public.vl_wa_mensajes
    FOR EACH ROW EXECUTE FUNCTION public.vl_wa_capturar_datos_entrega();

-- ============================================================
-- 3) El correo se puede ver y editar desde el panel
-- ============================================================

-- Se DROPea la firma vieja (10 args) para no dejar dos candidatas.
DROP FUNCTION IF EXISTS public.vl_actualizar_cliente(uuid, text, text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.vl_actualizar_cliente(
    p_cliente_id uuid,
    p_tiktok_user text DEFAULT NULL,
    p_nombre_real text DEFAULT NULL,
    p_whatsapp text DEFAULT NULL,
    p_ciudad text DEFAULT NULL,
    p_comuna text DEFAULT NULL,
    p_direccion text DEFAULT NULL,
    p_entrega_preferida text DEFAULT NULL,
    p_categoria text DEFAULT NULL,
    p_notas text DEFAULT NULL,
    p_correo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_tenant_cliente uuid;
    v_user text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT tenant_id INTO v_tenant_cliente
    FROM public.vl_clientes WHERE id = p_cliente_id;
    IF v_tenant_cliente IS DISTINCT FROM v_tenant THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    IF p_categoria IS NOT NULL AND p_categoria NOT IN ('nuevo', 'confiable', 'problematico', 'bloqueado') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Categoría inválida');
    END IF;
    IF p_entrega_preferida IS NOT NULL AND p_entrega_preferida <> '' AND p_entrega_preferida NOT IN ('envio', 'presencial') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Preferencia de entrega inválida');
    END IF;

    IF p_tiktok_user IS NOT NULL THEN
        v_user := public.vl_normalizar_tiktok(p_tiktok_user);
        IF v_user = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Usuario de TikTok inválido');
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.vl_clientes
            WHERE tenant_id = v_tenant AND tiktok_user = v_user AND id <> p_cliente_id
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Ya existe otro cliente con ese usuario de TikTok');
        END IF;
    END IF;

    UPDATE public.vl_clientes
    SET tiktok_user = CASE WHEN v_user IS NULL THEN tiktok_user ELSE v_user END,
        nombre_real = CASE WHEN p_nombre_real IS NULL THEN nombre_real ELSE btrim(p_nombre_real) END,
        whatsapp = CASE WHEN p_whatsapp IS NULL THEN whatsapp ELSE btrim(p_whatsapp) END,
        ciudad = CASE WHEN p_ciudad IS NULL THEN ciudad ELSE btrim(p_ciudad) END,
        comuna = CASE WHEN p_comuna IS NULL THEN comuna ELSE btrim(p_comuna) END,
        direccion = CASE WHEN p_direccion IS NULL THEN direccion ELSE btrim(p_direccion) END,
        correo = CASE WHEN p_correo IS NULL THEN correo ELSE btrim(p_correo) END,
        entrega_preferida = CASE
            WHEN p_entrega_preferida IS NULL THEN entrega_preferida
            WHEN btrim(p_entrega_preferida) = '' THEN NULL
            ELSE btrim(p_entrega_preferida)
        END,
        categoria = CASE WHEN p_categoria IS NULL THEN categoria ELSE p_categoria END,
        notas = CASE WHEN p_notas IS NULL THEN notas ELSE btrim(p_notas) END,
        updated_at = now()
    WHERE id = p_cliente_id;

    RETURN jsonb_build_object('ok', true, 'cliente_id', p_cliente_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vl_actualizar_cliente(uuid, text, text, text, text, text, text, text, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_actualizar_cliente(uuid, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- Lista de clientes: ahora devuelve también comuna/dirección/correo/contacto,
-- entrega preferida y el texto crudo de envío (lo usa Clientes y la ficha).
CREATE OR REPLACE FUNCTION public.vl_buscar_clientes(p_q text DEFAULT '', p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_limit int;
    v_pat_t text;
    v_pat_n text;
    v_res jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
    v_pat_t := '%' || public.vl_normalizar_tiktok(COALESCE(p_q, '')) || '%';
    v_pat_n := '%' || lower(btrim(COALESCE(p_q, ''))) || '%';

    SELECT jsonb_build_object(
        'ok', true,
        'clientes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'cliente_id', c.id,
                'tiktok_user', c.tiktok_user,
                'nombre_real', c.nombre_real,
                'whatsapp', c.whatsapp,
                'ciudad', c.ciudad,
                'comuna', c.comuna,
                'direccion', c.direccion,
                'correo', COALESCE(c.correo, ''),
                'contacto', COALESCE(c.contacto, ''),
                'datos_envio', COALESCE(c.datos_envio, ''),
                'entrega_preferida', c.entrega_preferida,
                'categoria', c.categoria,
                'proceso_activo', (SELECT jsonb_build_object(
                                        'proceso_id', pr.id,
                                        'estado', pr.estado,
                                        'saldo', public.vl_saldo_proceso(pr.id),
                                        'prendas', (SELECT count(*) FROM public.vl_items i
                                                   WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada'))
                                    )
                                    FROM public.vl_procesos pr
                                    WHERE pr.cliente_id = c.id AND pr.cerrado_en IS NULL
                                    LIMIT 1)
            ) ORDER BY c.updated_at DESC)
            FROM public.vl_clientes c
            WHERE c.tenant_id = v_tenant
              AND (btrim(COALESCE(p_q, '')) = ''
                   OR c.tiktok_user LIKE v_pat_t
                   OR lower(c.nombre_real) LIKE v_pat_n
                   OR c.whatsapp LIKE v_pat_n)
            LIMIT v_limit
        ), '[]'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.vl_buscar_clientes(text, int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_buscar_clientes(text, int) TO authenticated;

-- ============================================================
-- 4) Envíos: la tarjeta muestra correo y lo que escribió el cliente
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_envios_pendientes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    -- A diferencia de la versión anterior, esta lista sale del PROCESO (todos los
    -- pedidos abiertos), no de la fila de vl_envios: así Envíos y Procesos muestran
    -- LA MISMA información y un pedido sin entrega decidida también aparece.
    RETURN (
        WITH base AS (
            SELECT
                pr.id AS proceso_id,
                pr.estado AS proceso_estado,
                c.id AS cliente_id,
                c.tiktok_user, c.nombre_real, c.whatsapp, c.ciudad, c.comuna, c.direccion,
                COALESCE(c.correo, '')       AS correo,
                COALESCE(c.contacto, '')     AS contacto,
                COALESCE(c.datos_envio, '')  AS datos_envio,
                COALESCE(c.courier, '') AS courier,
                (pt->'puntos'->'entrega'->>'valor')    AS entrega,
                (pt->'puntos'->'entrega'->>'sugerido') AS entrega_sugerida,
                (pt->'puntos'->'pago'->>'valor')       AS pago_punto,
                (pt->'puntos'->'fecha'->>'valor')      AS fecha_punto,
                COALESCE((pt->>'saldo')::numeric, 0)   AS saldo,
                COALESCE((pt->>'total')::numeric, 0)   AS total,
                COALESCE((pt->>'prendas')::int, 0)     AS prendas,
                ev.id AS envio_id, ev.empresa, ev.tracking, ev.notas,
                ev.estado AS envio_estado, ev.fecha_programada, ev.updated_at AS envio_updated_at
            FROM public.vl_procesos pr
            JOIN public.vl_clientes c ON c.id = pr.cliente_id
            CROSS JOIN LATERAL public.vl_proceso_puntos(pr.id) pt
            LEFT JOIN public.vl_envios ev
                   ON ev.proceso_id = pr.id AND ev.estado <> 'cancelado'
            WHERE pr.tenant_id = v_tenant
              AND pr.cerrado_en IS NULL
        ),
        calc AS (
            SELECT b.*,
                CASE
                    -- Entregado pero todavía debe plata: es una TAREA (cobrar), no
                    -- un registro histórico.
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 'por_cobrar'
                    WHEN b.envio_estado = 'entregado'
                         AND b.envio_updated_at > now() - interval '7 days' THEN 'entregados'
                    WHEN b.envio_estado = 'entregado' THEN 'entregados_viejos'
                    WHEN b.entrega IS NULL THEN 'sin_entrega'
                    WHEN b.saldo > 0 AND b.entrega = 'presencial'
                         AND b.fecha_programada IS NOT NULL THEN 'presenciales'
                    -- Presencial sin fecha y SIN pagar -> SIN FECHA con la marca
                    -- 'posible soltar' (decide el negocio; el bot no escribe nada).
                    -- Va ANTES de la regla genérica de saldo para no caer en
                    -- 'esperando_pago'.
                    WHEN b.entrega = 'presencial' AND b.saldo > 0
                         AND b.fecha_programada IS NULL THEN 'sin_fecha'
                    WHEN b.saldo > 0 THEN 'esperando_pago'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') THEN 'listos'
                    WHEN b.envio_estado = 'en_proceso' THEN 'en_proceso'
                    WHEN b.courier = 'paket' THEN 'urgente_paket'
                    -- El envío todavía NO se creó en el courier (sin fila o en
                    -- 'pendiente'): el botón "ENVÍO CREADO" tiene que estar ahí.
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 'por_preparar'
                    WHEN b.fecha_programada IS NULL THEN 'sin_fecha'
                    WHEN b.fecha_programada <= CURRENT_DATE THEN 'hoy'
                    WHEN b.fecha_programada = CURRENT_DATE + 1 THEN 'manana'
                    ELSE 'proximos'
                END AS grupo,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0
                        THEN 'Entregado: falta cobrar ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' de ' || public.vl_wa_fmt_monto(b.total)
                             || '. Al cobrar el saldo el pedido se cierra solo.'
                    WHEN b.envio_estado = 'entregado' THEN 'Entrega registrada ✔'
                    WHEN b.entrega IS NULL AND b.saldo > 0
                        THEN 'Falta decidir entrega. Cobrar ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' o darle plazo y liberar la prenda.'
                    WHEN b.entrega IS NULL
                        THEN 'Falta decidir entrega: marcar envío o entrega presencial.'
                    WHEN b.saldo > 0 AND b.entrega = 'presencial'
                        THEN 'Entrega presencial con ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' por cobrar. Puede pagar al verse.'
                    WHEN b.saldo > 0
                        THEN 'Falta cobrar ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' (total ' || public.vl_wa_fmt_monto(b.total) || ').'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial')
                        THEN 'Listo para cerrar: marcar entregado.'
                    WHEN b.entrega = 'presencial'
                        THEN 'Coordinar la entrega presencial'
                             || CASE WHEN COALESCE(b.notas, '') <> ''
                                     THEN ' (dijo: ' || b.notas || ')' ELSE ' (sin fecha todavía)' END
                    WHEN b.envio_estado = 'en_proceso'
                        THEN 'En camino: marcar entregado cuando llegue.'
                    WHEN b.courier = 'paket'
                        THEN 'Pedir en Paket ANTES de las 23:59 del día anterior (solo Santiago, +$3.500)'
                    WHEN b.courier = 'blue'
                        THEN 'Pedir en Blue Express (el envío se paga al recibir)'
                    WHEN b.envio_id IS NULL
                        THEN 'Elegir courier (blue o paket) y crear el envío'
                    ELSE 'Envío creado: avisar al cliente y marcar entregado cuando llegue'
                END AS siguiente_paso,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 'pagar'
                    WHEN b.envio_estado = 'entregado' THEN 'abrir_chat'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') AND b.saldo <= 0
                        THEN 'entregado'
                    WHEN b.saldo > 0 THEN 'pagar'
                    WHEN b.entrega IS NULL THEN 'decidir_entrega'
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 'crear_envio'
                    ELSE 'abrir_chat'
                END AS accion,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 1
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') AND b.saldo <= 0 THEN 1
                    WHEN b.envio_estado = 'en_proceso' THEN 1
                    WHEN b.envio_estado = 'entregado' THEN 9
                    WHEN b.saldo > 0 THEN 4
                    WHEN b.entrega IS NULL THEN 3
                    WHEN b.courier = 'paket' THEN 2
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 2
                    WHEN b.fecha_programada IS NULL THEN 8
                    WHEN b.fecha_programada <= CURRENT_DATE THEN 5
                    WHEN b.fecha_programada = CURRENT_DATE + 1 THEN 6
                    ELSE 7
                END AS prioridad
            FROM base b
        )
        SELECT jsonb_build_object(
            'ok', true,
            'revisar_chat', true,
            'grupos', COALESCE((
                SELECT jsonb_object_agg(grupo, arr)
                FROM (
                    SELECT grupo, jsonb_agg(jsonb_build_object(
                        'envio_id', envio_id,
                        'proceso_id', proceso_id,
                        'cliente_id', cliente_id,
                        'tipo', entrega,
                        'tipo_sugerido', entrega_sugerida,
                        'empresa', empresa,
                        'tracking', tracking,
                        'fecha_programada', fecha_programada,
                        'envio_estado', envio_estado,
                        'proceso_estado', proceso_estado,
                        'pago_confirmado', (saldo <= 0),
                        'courier', courier,
                        'notas', COALESCE(notas, ''),
                        'fecha_dicha', COALESCE(notas, '') <> '',
                        -- Presencial sin fecha Y sin pagar: posible prenda a soltar
                        -- (silencioso: es un aviso para el negocio, no al cliente).
                        'posible_soltar', (entrega = 'presencial'
                                           AND saldo > 0
                                           AND fecha_programada IS NULL),
                        'saldo', saldo,
                        'total', total,
                        'prendas', prendas,
                        'siguiente_paso', siguiente_paso,
                        'accion', accion,
                        'prioridad', prioridad,
                        'cliente', jsonb_build_object(
                            'cliente_id', cliente_id,
                            'tiktok_user', tiktok_user, 'nombre_real', nombre_real,
                            'whatsapp', whatsapp, 'ciudad', ciudad,
                            'comuna', comuna, 'direccion', direccion,
                            -- Datos que el cliente escribió por WhatsApp (Ciclo 3):
                            'correo', correo, 'contacto', contacto,
                            'datos_envio', datos_envio
                        )
                    ) ORDER BY prioridad,
                        -- Lo PAGADO primero (ya se puede entregar); lo que debe plata
                        -- queda después dentro de su grupo, salvo en "falta cobrar".
                        (saldo > 0),
                        fecha_programada NULLS LAST,
                        tiktok_user) AS arr
                    FROM calc
                    GROUP BY grupo
                ) t
            ), '{}'::jsonb)
        )
    );
END;
$function$;

-- ── Permisos + recarga de esquema ───────────────────────────────────────────

REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_envios_pendientes() TO authenticated;

NOTIFY pgrst, 'reload schema';
