drop extension if exists "pg_net";

create sequence "public"."servicios_id_seq";


  create table "public"."citas" (
    "id" text not null,
    "tenant_id" uuid,
    "servicio_id" bigint,
    "fecha" date not null,
    "hora" text not null,
    "precio" numeric(10,2),
    "contacto" jsonb not null,
    "notificaciones" jsonb default '{"emailEnviado": false, "whatsappEnviado": false}'::jsonb,
    "created_at" timestamp without time zone default now()
      );


alter table "public"."citas" enable row level security;


  create table "public"."notificaciones_admin" (
    "id" text not null,
    "tenant_id" uuid,
    "tipo" text,
    "cita_id" text,
    "fecha_original" text,
    "hora_original" text,
    "fecha_nueva" text,
    "hora_nueva" text,
    "cliente" jsonb,
    "leido" boolean default false,
    "creado_en" timestamp without time zone default now()
      );


alter table "public"."notificaciones_admin" enable row level security;


  create table "public"."servicios" (
    "id" bigint not null default nextval('public.servicios_id_seq'::regclass),
    "tenant_id" uuid,
    "nombre" text not null,
    "categoria" text,
    "precio" numeric(10,2),
    "descripcion" text,
    "imagen" text,
    "destacado" boolean default false,
    "activo" boolean default true,
    "disponibilidad" jsonb default '{}'::jsonb,
    "fechas" text[] default '{}'::text[],
    "created_at" timestamp without time zone default now()
      );


alter table "public"."servicios" enable row level security;


  create table "public"."subscriptions" (
    "id" uuid not null default gen_random_uuid(),
    "tenant_id" uuid not null,
    "plan" text not null,
    "status" text not null,
    "start_date" timestamp with time zone not null default now(),
    "end_date" timestamp with time zone,
    "stripe_session_id" text,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now()
      );


alter table "public"."subscriptions" enable row level security;


  create table "public"."tenant_config" (
    "tenant_id" uuid not null,
    "primary_color" text default '#9d4edd'::text,
    "secondary_color" text default '#ff6d00'::text,
    "logo_url" text,
    "custom_css" text,
    "updated_at" timestamp with time zone default now()
      );


alter table "public"."tenant_config" enable row level security;


  create table "public"."tenants" (
    "id" uuid not null default gen_random_uuid(),
    "nombre_negocio" text not null,
    "email_contacto" text not null,
    "plan" text default 'freemium'::text,
    "fecha_registro" timestamp without time zone default now(),
    "estado" text default 'activo'::text,
    "configuracion" jsonb default '{}'::jsonb
      );


alter table "public"."tenants" enable row level security;

alter sequence "public"."servicios_id_seq" owned by "public"."servicios"."id";

CREATE UNIQUE INDEX citas_pkey ON public.citas USING btree (id);

CREATE INDEX idx_citas_fecha ON public.citas USING btree (fecha);

CREATE INDEX idx_citas_servicio ON public.citas USING btree (servicio_id);

CREATE INDEX idx_citas_tenant ON public.citas USING btree (tenant_id);

CREATE INDEX idx_notificaciones_leido ON public.notificaciones_admin USING btree (leido);

CREATE INDEX idx_notificaciones_tenant ON public.notificaciones_admin USING btree (tenant_id);

CREATE INDEX idx_servicios_activo ON public.servicios USING btree (activo);

CREATE INDEX idx_servicios_tenant ON public.servicios USING btree (tenant_id);

CREATE INDEX idx_subscriptions_status ON public.subscriptions USING btree (status);

CREATE INDEX idx_subscriptions_tenant_id ON public.subscriptions USING btree (tenant_id);

CREATE INDEX idx_tenant_config_tenant_id ON public.tenant_config USING btree (tenant_id);

CREATE INDEX idx_tenants_email ON public.tenants USING btree (email_contacto);

CREATE UNIQUE INDEX notificaciones_admin_pkey ON public.notificaciones_admin USING btree (id);

CREATE UNIQUE INDEX servicios_pkey ON public.servicios USING btree (id);

CREATE UNIQUE INDEX subscriptions_pkey ON public.subscriptions USING btree (id);

CREATE UNIQUE INDEX tenant_config_pkey ON public.tenant_config USING btree (tenant_id);

CREATE UNIQUE INDEX tenants_pkey ON public.tenants USING btree (id);

alter table "public"."citas" add constraint "citas_pkey" PRIMARY KEY using index "citas_pkey";

alter table "public"."notificaciones_admin" add constraint "notificaciones_admin_pkey" PRIMARY KEY using index "notificaciones_admin_pkey";

alter table "public"."servicios" add constraint "servicios_pkey" PRIMARY KEY using index "servicios_pkey";

alter table "public"."subscriptions" add constraint "subscriptions_pkey" PRIMARY KEY using index "subscriptions_pkey";

alter table "public"."tenant_config" add constraint "tenant_config_pkey" PRIMARY KEY using index "tenant_config_pkey";

alter table "public"."tenants" add constraint "tenants_pkey" PRIMARY KEY using index "tenants_pkey";

alter table "public"."citas" add constraint "citas_servicio_id_fkey" FOREIGN KEY (servicio_id) REFERENCES public.servicios(id) not valid;

alter table "public"."citas" validate constraint "citas_servicio_id_fkey";

alter table "public"."citas" add constraint "citas_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE not valid;

alter table "public"."citas" validate constraint "citas_tenant_id_fkey";

alter table "public"."notificaciones_admin" add constraint "notificaciones_admin_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE not valid;

alter table "public"."notificaciones_admin" validate constraint "notificaciones_admin_tenant_id_fkey";

alter table "public"."servicios" add constraint "servicios_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE not valid;

alter table "public"."servicios" validate constraint "servicios_tenant_id_fkey";

alter table "public"."subscriptions" add constraint "subscriptions_plan_check" CHECK ((plan = ANY (ARRAY['freemium'::text, 'pro'::text, 'premium_anual'::text]))) not valid;

alter table "public"."subscriptions" validate constraint "subscriptions_plan_check";

alter table "public"."subscriptions" add constraint "subscriptions_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'trial'::text]))) not valid;

alter table "public"."subscriptions" validate constraint "subscriptions_status_check";

alter table "public"."subscriptions" add constraint "subscriptions_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE not valid;

alter table "public"."subscriptions" validate constraint "subscriptions_tenant_id_fkey";

alter table "public"."tenant_config" add constraint "tenant_config_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE not valid;

alter table "public"."tenant_config" validate constraint "tenant_config_tenant_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_initial_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
    VALUES (NEW.id, COALESCE(NEW.plan, 'freemium'), 'active', now());
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_all_users_for_superadmin()
 RETURNS TABLE(id uuid, email text, rol text, nombre text, tenant_id text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_email text;
BEGIN
  -- Obtener email del usuario que llama desde el JWT (más seguro que auth.email())
  caller_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
  
  IF caller_email IS NULL OR caller_email != 'super@admin.com' THEN
    RAISE EXCEPTION 'Acceso denegado: solo super-admin';
  END IF;
  
  RETURN QUERY
  SELECT 
    u.id,
    u.email,
    u.raw_user_meta_data->>'rol' AS rol,
    u.raw_user_meta_data->>'nombre' AS nombre,
    u.raw_user_meta_data->>'tenant_id' AS tenant_id,
    u.created_at
  FROM auth.users u
  ORDER BY u.created_at DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
    SELECT COALESCE(
        (current_setting('request.jwt.claims', true)::jsonb -> 'user_metadata' ->> 'tenant_id')::uuid,
        NULL
    );
$function$
;

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT COALESCE(
        (current_setting('request.jwt.claims', true)::jsonb -> 'user_metadata' ->> 'rol') = 'super_admin',
        false
    );
$function$
;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_tenant(tenant_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    PERFORM set_config('app.tenant_id', tenant_id, false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_tenant_config_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$
;

create or replace view "public"."usuarios_con_rol" as  SELECT id,
    email,
    (raw_user_meta_data ->> 'nombre'::text) AS nombre,
    (raw_user_meta_data ->> 'rol'::text) AS rol,
    (raw_user_meta_data ->> 'tenant_id'::text) AS tenant_id,
    created_at,
    last_sign_in_at
   FROM auth.users
  WHERE ((raw_user_meta_data ->> 'rol'::text) IS NOT NULL);


grant delete on table "public"."citas" to "anon";

grant insert on table "public"."citas" to "anon";

grant references on table "public"."citas" to "anon";

grant select on table "public"."citas" to "anon";

grant trigger on table "public"."citas" to "anon";

grant truncate on table "public"."citas" to "anon";

grant update on table "public"."citas" to "anon";

grant delete on table "public"."citas" to "authenticated";

grant insert on table "public"."citas" to "authenticated";

grant references on table "public"."citas" to "authenticated";

grant select on table "public"."citas" to "authenticated";

grant trigger on table "public"."citas" to "authenticated";

grant truncate on table "public"."citas" to "authenticated";

grant update on table "public"."citas" to "authenticated";

grant delete on table "public"."citas" to "service_role";

grant insert on table "public"."citas" to "service_role";

grant references on table "public"."citas" to "service_role";

grant select on table "public"."citas" to "service_role";

grant trigger on table "public"."citas" to "service_role";

grant truncate on table "public"."citas" to "service_role";

grant update on table "public"."citas" to "service_role";

grant delete on table "public"."notificaciones_admin" to "anon";

grant insert on table "public"."notificaciones_admin" to "anon";

grant references on table "public"."notificaciones_admin" to "anon";

grant select on table "public"."notificaciones_admin" to "anon";

grant trigger on table "public"."notificaciones_admin" to "anon";

grant truncate on table "public"."notificaciones_admin" to "anon";

grant update on table "public"."notificaciones_admin" to "anon";

grant delete on table "public"."notificaciones_admin" to "authenticated";

grant insert on table "public"."notificaciones_admin" to "authenticated";

grant references on table "public"."notificaciones_admin" to "authenticated";

grant select on table "public"."notificaciones_admin" to "authenticated";

grant trigger on table "public"."notificaciones_admin" to "authenticated";

grant truncate on table "public"."notificaciones_admin" to "authenticated";

grant update on table "public"."notificaciones_admin" to "authenticated";

grant delete on table "public"."notificaciones_admin" to "service_role";

grant insert on table "public"."notificaciones_admin" to "service_role";

grant references on table "public"."notificaciones_admin" to "service_role";

grant select on table "public"."notificaciones_admin" to "service_role";

grant trigger on table "public"."notificaciones_admin" to "service_role";

grant truncate on table "public"."notificaciones_admin" to "service_role";

grant update on table "public"."notificaciones_admin" to "service_role";

grant delete on table "public"."servicios" to "anon";

grant insert on table "public"."servicios" to "anon";

grant references on table "public"."servicios" to "anon";

grant select on table "public"."servicios" to "anon";

grant trigger on table "public"."servicios" to "anon";

grant truncate on table "public"."servicios" to "anon";

grant update on table "public"."servicios" to "anon";

grant delete on table "public"."servicios" to "authenticated";

grant insert on table "public"."servicios" to "authenticated";

grant references on table "public"."servicios" to "authenticated";

grant select on table "public"."servicios" to "authenticated";

grant trigger on table "public"."servicios" to "authenticated";

grant truncate on table "public"."servicios" to "authenticated";

grant update on table "public"."servicios" to "authenticated";

grant delete on table "public"."servicios" to "service_role";

grant insert on table "public"."servicios" to "service_role";

grant references on table "public"."servicios" to "service_role";

grant select on table "public"."servicios" to "service_role";

grant trigger on table "public"."servicios" to "service_role";

grant truncate on table "public"."servicios" to "service_role";

grant update on table "public"."servicios" to "service_role";

grant delete on table "public"."subscriptions" to "anon";

grant insert on table "public"."subscriptions" to "anon";

grant references on table "public"."subscriptions" to "anon";

grant select on table "public"."subscriptions" to "anon";

grant trigger on table "public"."subscriptions" to "anon";

grant truncate on table "public"."subscriptions" to "anon";

grant update on table "public"."subscriptions" to "anon";

grant delete on table "public"."subscriptions" to "authenticated";

grant insert on table "public"."subscriptions" to "authenticated";

grant references on table "public"."subscriptions" to "authenticated";

grant select on table "public"."subscriptions" to "authenticated";

grant trigger on table "public"."subscriptions" to "authenticated";

grant truncate on table "public"."subscriptions" to "authenticated";

grant update on table "public"."subscriptions" to "authenticated";

grant delete on table "public"."subscriptions" to "service_role";

grant insert on table "public"."subscriptions" to "service_role";

grant references on table "public"."subscriptions" to "service_role";

grant select on table "public"."subscriptions" to "service_role";

grant trigger on table "public"."subscriptions" to "service_role";

grant truncate on table "public"."subscriptions" to "service_role";

grant update on table "public"."subscriptions" to "service_role";

grant delete on table "public"."tenant_config" to "anon";

grant insert on table "public"."tenant_config" to "anon";

grant references on table "public"."tenant_config" to "anon";

grant select on table "public"."tenant_config" to "anon";

grant trigger on table "public"."tenant_config" to "anon";

grant truncate on table "public"."tenant_config" to "anon";

grant update on table "public"."tenant_config" to "anon";

grant delete on table "public"."tenant_config" to "authenticated";

grant insert on table "public"."tenant_config" to "authenticated";

grant references on table "public"."tenant_config" to "authenticated";

grant select on table "public"."tenant_config" to "authenticated";

grant trigger on table "public"."tenant_config" to "authenticated";

grant truncate on table "public"."tenant_config" to "authenticated";

grant update on table "public"."tenant_config" to "authenticated";

grant delete on table "public"."tenant_config" to "service_role";

grant insert on table "public"."tenant_config" to "service_role";

grant references on table "public"."tenant_config" to "service_role";

grant select on table "public"."tenant_config" to "service_role";

grant trigger on table "public"."tenant_config" to "service_role";

grant truncate on table "public"."tenant_config" to "service_role";

grant update on table "public"."tenant_config" to "service_role";

grant delete on table "public"."tenants" to "anon";

grant insert on table "public"."tenants" to "anon";

grant references on table "public"."tenants" to "anon";

grant select on table "public"."tenants" to "anon";

grant trigger on table "public"."tenants" to "anon";

grant truncate on table "public"."tenants" to "anon";

grant update on table "public"."tenants" to "anon";

grant delete on table "public"."tenants" to "authenticated";

grant insert on table "public"."tenants" to "authenticated";

grant references on table "public"."tenants" to "authenticated";

grant select on table "public"."tenants" to "authenticated";

grant trigger on table "public"."tenants" to "authenticated";

grant truncate on table "public"."tenants" to "authenticated";

grant update on table "public"."tenants" to "authenticated";

grant delete on table "public"."tenants" to "service_role";

grant insert on table "public"."tenants" to "service_role";

grant references on table "public"."tenants" to "service_role";

grant select on table "public"."tenants" to "service_role";

grant trigger on table "public"."tenants" to "service_role";

grant truncate on table "public"."tenants" to "service_role";

grant update on table "public"."tenants" to "service_role";


  create policy "Admin ve/gestiona citas de su tenant"
  on "public"."citas"
  as permissive
  for all
  to authenticated
using (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)))
with check ((tenant_id = public.get_user_tenant_id()));



  create policy "Anon puede insertar citas en su tenant"
  on "public"."citas"
  as permissive
  for insert
  to public
with check (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));



  create policy "Anon puede leer citas de su tenant"
  on "public"."citas"
  as permissive
  for select
  to public
using (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));



  create policy "Cliente actualiza citas futuras"
  on "public"."citas"
  as permissive
  for update
  to authenticated
using (((((contacto ->> 'userId'::text))::uuid = auth.uid()) AND (fecha > now()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'cliente'::text)))
with check (((((contacto ->> 'userId'::text))::uuid = auth.uid()) AND (fecha > now()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'cliente'::text)));



  create policy "Cliente crea citas"
  on "public"."citas"
  as permissive
  for insert
  to authenticated
with check (((((contacto ->> 'userId'::text))::uuid = auth.uid()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'cliente'::text)));



  create policy "Cliente elimina citas futuras"
  on "public"."citas"
  as permissive
  for delete
  to authenticated
using (((((contacto ->> 'userId'::text))::uuid = auth.uid()) AND (fecha > now()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'cliente'::text)));



  create policy "Cliente ve sus propias citas"
  on "public"."citas"
  as permissive
  for select
  to authenticated
using (((((contacto ->> 'userId'::text))::uuid = auth.uid()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'cliente'::text)));



  create policy "Super admin todo en citas"
  on "public"."citas"
  as permissive
  for all
  to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());



  create policy "Admin ve notificaciones de su tenant"
  on "public"."notificaciones_admin"
  as permissive
  for select
  to authenticated
using (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)));



  create policy "Sistema crea notificaciones"
  on "public"."notificaciones_admin"
  as permissive
  for insert
  to authenticated
with check (true);



  create policy "Super admin todo en notificaciones"
  on "public"."notificaciones_admin"
  as permissive
  for all
  to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());



  create policy "Admin gestiona servicios de su tenant"
  on "public"."servicios"
  as permissive
  for all
  to authenticated
using (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)))
with check ((tenant_id = public.get_user_tenant_id()));



  create policy "Anon puede leer servicios de su tenant"
  on "public"."servicios"
  as permissive
  for select
  to public
using (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));



  create policy "Super admin todo en servicios"
  on "public"."servicios"
  as permissive
  for all
  to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());



  create policy "Todos ven servicios de su tenant"
  on "public"."servicios"
  as permissive
  for select
  to authenticated
using ((tenant_id = public.get_user_tenant_id()));



  create policy "Admin actualiza su suscripción"
  on "public"."subscriptions"
  as permissive
  for update
  to authenticated
using (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)))
with check (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)));



  create policy "Admin ve sus suscripciones"
  on "public"."subscriptions"
  as permissive
  for select
  to authenticated
using (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)));



  create policy "Super admin todo en subscriptions"
  on "public"."subscriptions"
  as permissive
  for all
  to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());



  create policy "Admin gestiona su tenant_config"
  on "public"."tenant_config"
  as permissive
  for all
  to authenticated
using (((tenant_id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)))
with check ((tenant_id = public.get_user_tenant_id()));



  create policy "Lectura tenant_config por tenant"
  on "public"."tenant_config"
  as permissive
  for select
  to authenticated
using ((tenant_id = public.get_user_tenant_id()));



  create policy "Super admin todo en tenant_config"
  on "public"."tenant_config"
  as permissive
  for all
  to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());



  create policy "Admin puede actualizar su tenant"
  on "public"."tenants"
  as permissive
  for update
  to authenticated
using (((id = public.get_user_tenant_id()) AND ((((auth.jwt() ->> 'user_metadata'::text))::jsonb ->> 'rol'::text) = 'admin'::text)))
with check ((id = public.get_user_tenant_id()));



  create policy "Super admin todo en tenants"
  on "public"."tenants"
  as permissive
  for all
  to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());



  create policy "Usuarios autenticados pueden crear tenants"
  on "public"."tenants"
  as permissive
  for insert
  to authenticated
with check (true);



  create policy "Usuarios ven su propio tenant"
  on "public"."tenants"
  as permissive
  for select
  to authenticated
using ((id = public.get_user_tenant_id()));


CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_tenant_config_updated_at BEFORE UPDATE ON public.tenant_config FOR EACH ROW EXECUTE FUNCTION public.update_tenant_config_updated_at();

CREATE TRIGGER trg_create_subscription_on_tenant AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.create_initial_subscription();


