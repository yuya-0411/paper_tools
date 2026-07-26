-- Paper Tools cloud sync schema
--
-- Run this file in Supabase Dashboard > SQL Editor as the project owner.
-- It is safe to run again: objects are created or replaced deterministically.

begin;

create table if not exists public.projects (
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  cloud_id uuid not null default pg_catalog.gen_random_uuid(),
  payload jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),

  constraint projects_pkey primary key (owner_id, project_id),
  constraint projects_cloud_id_key unique (cloud_id),
  constraint projects_project_id_format check (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'
  ),
  constraint projects_payload_is_object check (
    pg_catalog.jsonb_typeof(payload) = 'object'
  ),
  constraint projects_revision_positive check (revision >= 1)
);

-- Upgrade an earlier preview schema without dropping existing manuscripts.
alter table public.projects
  add column if not exists created_at timestamptz
  not null default pg_catalog.clock_timestamp();

alter table public.projects
  drop constraint if exists projects_project_id_format;
alter table public.projects
  add constraint projects_project_id_format check (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'
  );

create index if not exists projects_owner_updated_at_idx
  on public.projects (owner_id, updated_at desc);

-- Recreate the size constraint so this file also upgrades an earlier schema.
-- Binary data belongs in Storage and must never be embedded in payload.
alter table public.projects
  drop constraint if exists projects_payload_max_bytes;
alter table public.projects
  add constraint projects_payload_max_bytes check (
    pg_catalog.octet_length(payload::text) <= 4194304
  );
alter table public.projects
  drop constraint if exists projects_payload_project_id_matches;
alter table public.projects
  add constraint projects_payload_project_id_matches check (
    pg_catalog.jsonb_extract_path_text(payload, 'id')
      is not distinct from project_id
  );

comment on table public.projects is
  'Current Paper Tools project snapshots. RLS limits every row to its owner.';
comment on column public.projects.owner_id is
  'Supabase Auth user id. save_project derives it from auth.uid(); browser code must not choose another owner.';
comment on column public.projects.project_id is
  'Device-local Paper Tools project id. It is unique within one owner account and is never used as an asset path.';
comment on column public.projects.cloud_id is
  'Database-generated immutable UUID used to associate private Storage objects.';
comment on column public.projects.payload is
  'Current normalized project JSON. Binary assets are stored in the private paper-assets bucket.';
comment on column public.projects.revision is
  'Monotonic concurrency token. New records start at 1.';

alter table public.projects enable row level security;
alter table public.projects force row level security;

drop policy if exists projects_select_own on public.projects;
create policy projects_select_own
  on public.projects
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists projects_insert_own on public.projects;
drop policy if exists projects_update_own on public.projects;
drop policy if exists projects_delete_own on public.projects;

-- Keep identity and timestamps server-controlled, and prevent revision rollback
-- even if a client bypasses the normal save_project RPC.
create or replace function public.enforce_project_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.owner_id is distinct from old.owner_id
     or new.project_id is distinct from old.project_id
     or new.cloud_id is distinct from old.cloud_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Project identity cannot be changed'
      using errcode = '42501';
  end if;

  if old.revision = 9223372036854775807 then
    raise exception 'Project revision has reached its maximum value'
      using errcode = '22003';
  end if;

  if new.revision is distinct from old.revision + 1 then
    raise exception 'Project revision must increase by exactly one'
      using errcode = '22023';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists projects_enforce_update on public.projects;
create trigger projects_enforce_update
  before update on public.projects
  for each row
  execute function public.enforce_project_update();

revoke all on function public.enforce_project_update() from public, anon, authenticated;

-- The browser may SELECT its own rows through RLS, but all mutations must pass
-- through the audited SECURITY DEFINER RPCs below.
revoke all on table public.projects from public, anon, authenticated;
grant select on table public.projects to authenticated;

-- Atomic optimistic-concurrency save.
--
-- expected_revision = 0 creates a project at revision 1.
-- expected_revision >= 1 updates only that exact revision.
-- A conflict never overwrites the newer row and returns no manuscript payload.
create or replace function public.save_project(
  p_project_id text,
  expected_revision bigint,
  new_payload jsonb
)
returns table (
  status text,
  cloud_id uuid,
  revision bigint,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_owner_id uuid := (select auth.uid());
  v_cloud_id uuid;
  v_revision bigint;
  v_updated_at timestamptz;
begin
  if v_owner_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  if p_project_id is null
     or p_project_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' then
    raise exception 'Invalid project id'
      using errcode = '22023';
  end if;

  if new_payload is null
     or pg_catalog.jsonb_typeof(new_payload) <> 'object' then
    raise exception 'Project payload must be a JSON object'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_extract_path_text(new_payload, 'id')
       is distinct from p_project_id then
    raise exception 'Project payload id does not match project id'
      using errcode = '22023';
  end if;

  if pg_catalog.octet_length(new_payload::text) > 4194304 then
    raise exception 'Project payload exceeds the 4 MiB limit'
      using errcode = '22001';
  end if;

  if expected_revision is null
     or expected_revision < 0
     or expected_revision = 9223372036854775807 then
    raise exception 'Expected revision is outside the supported range'
      using errcode = '22023';
  end if;

  if expected_revision = 0 then
    insert into public.projects as p (owner_id, project_id, payload)
    values (v_owner_id, p_project_id, new_payload)
    on conflict (owner_id, project_id) do nothing
    returning p.cloud_id, p.revision, p.updated_at
      into v_cloud_id, v_revision, v_updated_at;
  else
    update public.projects as p
       set payload = new_payload,
           revision = p.revision + 1
     where p.owner_id = v_owner_id
       and p.project_id = p_project_id
       and p.revision = expected_revision
    returning p.cloud_id, p.revision, p.updated_at
      into v_cloud_id, v_revision, v_updated_at;
  end if;

  if found then
    return query
      select 'saved'::text, v_cloud_id, v_revision, v_updated_at;
    return;
  end if;

  select p.cloud_id, p.revision, p.updated_at
    into v_cloud_id, v_revision, v_updated_at
    from public.projects as p
   where p.owner_id = v_owner_id
     and p.project_id = p_project_id;

  if found then
    return query
      select 'conflict'::text, v_cloud_id, v_revision, v_updated_at;
  else
    return query
      select 'not_found'::text, null::uuid, null::bigint, null::timestamptz;
  end if;
end;
$function$;

revoke all on function public.save_project(text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_project(text, bigint, jsonb)
  to authenticated;

-- Atomic delete with the same optimistic-concurrency rule as save_project.
-- The project is never deleted while payload.assets contains any item.
create or replace function public.delete_project(
  p_project_id text,
  expected_revision bigint
)
returns table (
  status text,
  cloud_id uuid,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_owner_id uuid := (select auth.uid());
  v_cloud_id uuid;
  v_revision bigint;
  v_assets_empty boolean;
begin
  if v_owner_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  if p_project_id is null
     or p_project_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' then
    raise exception 'Invalid project id'
      using errcode = '22023';
  end if;

  if expected_revision is null or expected_revision < 1 then
    raise exception 'Expected revision must be one or greater'
      using errcode = '22023';
  end if;

  -- Lock the owner-scoped row before checking revision and attachments.
  -- Concurrent saves and deletes must wait until this transaction finishes.
  select
    p.cloud_id,
    p.revision,
    case
      when pg_catalog.jsonb_typeof(
        pg_catalog.jsonb_extract_path(p.payload, 'assets')
      ) = 'array' then
        pg_catalog.jsonb_array_length(
          pg_catalog.jsonb_extract_path(p.payload, 'assets')
        ) = 0
      else false
    end
    into v_cloud_id, v_revision, v_assets_empty
    from public.projects as p
   where p.owner_id = v_owner_id
     and p.project_id = p_project_id
   for update;

  if not found then
    return query
      select 'not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_revision <> expected_revision then
    return query
      select 'conflict'::text, v_cloud_id, v_revision;
    return;
  end if;

  if not v_assets_empty then
    return query
      select 'attachments_present'::text, v_cloud_id, v_revision;
    return;
  end if;

  -- Repeat the fail-closed predicate in DELETE itself. Malformed, null or
  -- non-array assets values are not considered empty.
  delete from public.projects as p
   where p.owner_id = v_owner_id
     and p.project_id = p_project_id
     and p.revision = expected_revision
     and case
       when pg_catalog.jsonb_typeof(
         pg_catalog.jsonb_extract_path(p.payload, 'assets')
       ) = 'array' then
         pg_catalog.jsonb_array_length(
           pg_catalog.jsonb_extract_path(p.payload, 'assets')
         ) = 0
       else false
     end
  returning p.cloud_id, p.revision
    into v_cloud_id, v_revision;

  if found then
    return query
      select 'deleted'::text, v_cloud_id, v_revision;
  else
    -- Unreachable while the row lock is held; fail closed if invariants change.
    return query
      select 'attachments_present'::text, v_cloud_id, v_revision;
  end if;
end;
$function$;

revoke all on function public.delete_project(text, bigint)
  from public, anon, authenticated;
grant execute on function public.delete_project(text, bigint)
  to authenticated;

-- Private object storage. Object names must use:
--   {auth.uid()}/{database-issued cloud_id}/{RFC 4122 asset UUID}/payload.{safe_extension}
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'paper-assets',
  'paper-assets',
  false,
  52428800,
  array[
    'image/png',
    'image/jpeg',
    'application/pdf',
    'text/csv',
    'application/json',
    'text/plain',
    'application/yaml'
  ]::text[]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists paper_assets_select_own on storage.objects;
create policy paper_assets_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'paper-assets'
    and owner_id = ((select auth.uid())::text)
    and pg_catalog.cardinality(storage.foldername(name)) = 3
    and (storage.foldername(name))[1] = ((select auth.uid())::text)
    and (storage.foldername(name))[3]
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and storage.filename(name)
      ~ '^payload\.(png|jpe?g|pdf|csv|json|txt|ya?ml)$'
    and exists (
      select 1
        from public.projects as p
       where p.owner_id = (select auth.uid())
         and p.cloud_id::text = (storage.foldername(name))[2]
    )
  );

drop policy if exists paper_assets_insert_own on storage.objects;
create policy paper_assets_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'paper-assets'
    and owner_id = ((select auth.uid())::text)
    and pg_catalog.cardinality(storage.foldername(name)) = 3
    and (storage.foldername(name))[1] = ((select auth.uid())::text)
    and (storage.foldername(name))[3]
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and storage.filename(name)
      ~ '^payload\.(png|jpe?g|pdf|csv|json|txt|ya?ml)$'
    and exists (
      select 1
        from public.projects as p
       where p.owner_id = (select auth.uid())
         and p.cloud_id::text = (storage.foldername(name))[2]
    )
  );

drop policy if exists paper_assets_update_own on storage.objects;
drop policy if exists paper_assets_delete_own on storage.objects;
-- Version 1 treats uploaded objects as immutable. Authenticated users may read
-- and insert only; replacement and cleanup require a trusted administrator.

commit;
