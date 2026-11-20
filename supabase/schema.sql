-- Proview Jobs: database for the job management app.
-- Managers create and assign jobs; staff see only the jobs assigned to them.
-- Run once in a new Supabase project (SQL editor), then deploy supabase/functions/whatsapp-webhook.

create schema if not exists pj_private;

-- ---------------------------------------------------------------- 1. Tables
create table public.pj_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique check (email = lower(email) and email like '%_@_%'),
  name text not null check (length(trim(name)) > 0),
  role text not null default 'staff' check (role in ('manager','staff')),
  phone text check (phone is null or phone ~ '^[0-9]{7,15}$'),  -- WhatsApp number, digits with country code
  active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on column public.pj_people.phone is 'WhatsApp number: digits only, with country code, no + (for example 447700900123).';

create table public.pj_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'Europe/London',
  business_name text not null default 'Proview Tech',
  wa_any_message boolean not null default true  -- any message from an approved number is a job (no "Job" prefix needed)
);
insert into public.pj_settings default values;

create table public.pj_jobs (
  id uuid primary key default gen_random_uuid(),
  ref integer generated always as identity unique,
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  customer_name text not null default '',
  customer_phone text not null default '',
  address text not null default '',
  due_date date,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  assigned_to uuid references public.pj_people(id) on delete set null,
  created_by uuid references public.pj_people(id) on delete set null,
  source text not null default 'app' check (source in ('app','whatsapp')),
  completion_notes text not null default '',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pj_jobs_assigned_idx on public.pj_jobs (assigned_to, status);
create index pj_jobs_created_by_idx on public.pj_jobs (created_by);

create table public.pj_job_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pj_jobs(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  done boolean not null default false,
  done_at timestamptz,
  sort integer not null default 0
);
create index pj_job_tasks_job_idx on public.pj_job_tasks (job_id);

create table public.pj_job_parts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pj_jobs(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  qty numeric not null default 1 check (qty > 0),
  used boolean not null default false,
  sort integer not null default 0
);
create index pj_job_parts_job_idx on public.pj_job_parts (job_id);

create table public.pj_job_photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pj_jobs(id) on delete cascade,
  path text not null unique,
  uploaded_by uuid references public.pj_people(id) on delete set null,
  created_at timestamptz not null default now()
);
create index pj_job_photos_job_idx on public.pj_job_photos (job_id);
create index pj_job_photos_by_idx on public.pj_job_photos (uploaded_by);

-- Only messages that start with the word "job" are ever stored here.
create table public.pj_wa_log (
  id uuid primary key default gen_random_uuid(),
  wa_id text unique,
  from_phone text,
  body text,
  source text not null default 'whatsapp',
  job_id uuid references public.pj_jobs(id) on delete set null,
  result text,
  created_at timestamptz not null default now()
);
create index pj_wa_log_job_idx on public.pj_wa_log (job_id);

-- WhatsApp numbers that may create jobs and/or are sent every new job, whether or not they have a login.
create table public.pj_wa_numbers (
  phone text primary key check (phone ~ '^[0-9]{7,15}$'),
  label text not null default '',
  can_create boolean not null default true,
  notify boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 2. Who is asking
create function pj_private.me() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.pj_people where user_id = (select auth.uid()) and active
$$;

create function pj_private.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pj_people
                 where user_id = (select auth.uid()) and active and role = 'manager')
$$;

create function pj_private.can_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select pj_private.is_manager()
      or exists (select 1 from public.pj_jobs j where j.id = p_job and j.assigned_to = pj_private.me())
$$;

-- For photo files: the first folder of the file path is the job id.
create function pj_private.can_see_job_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  begin
    v := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  return pj_private.can_see_job(v);
end $$;

-- ---------------------------------------------------------------- 3. Housekeeping triggers
create function pj_private.job_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.status = 'done' then new.completed_at := now(); end if;
    return new;
  end if;
  if new.status = 'done' and old.status <> 'done' then new.completed_at := now(); end if;
  if new.status <> 'done' then new.completed_at := null; end if;
  if new.status = 'in_progress' and new.started_at is null then new.started_at := now(); end if;
  return new;
end $$;
create trigger pj_jobs_touch before insert or update on public.pj_jobs
  for each row execute function pj_private.job_touch();

create function pj_private.task_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.done and (tg_op = 'INSERT' or not old.done) then new.done_at := now(); end if;
  if not new.done then new.done_at := null; end if;
  return new;
end $$;
create trigger pj_job_tasks_touch before insert or update on public.pj_job_tasks
  for each row execute function pj_private.task_touch();

-- There must always be a manager left who can run the app.
create function pj_private.keep_a_manager() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.pj_people)
     and not exists (select 1 from public.pj_people where role = 'manager' and active) then
    raise exception 'There must be at least one active manager';
  end if;
  return null;
end $$;
create trigger pj_people_keep_manager after update or delete on public.pj_people
  for each statement execute function pj_private.keep_a_manager();

-- ---------------------------------------------------------------- 4. Row-level security
alter table public.pj_people     enable row level security;
alter table public.pj_settings   enable row level security;
alter table public.pj_jobs       enable row level security;
alter table public.pj_job_tasks  enable row level security;
alter table public.pj_job_parts  enable row level security;
alter table public.pj_job_photos enable row level security;
alter table public.pj_wa_log     enable row level security;
alter table public.pj_wa_numbers enable row level security;

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on public.pj_people, public.pj_jobs, public.pj_job_tasks,
  public.pj_job_parts, public.pj_job_photos to authenticated;
grant select, update on public.pj_settings to authenticated;
grant select on public.pj_wa_log to authenticated;
grant select, insert, update, delete on public.pj_wa_numbers to authenticated;
grant all on all tables in schema public to service_role;

grant usage on schema pj_private to authenticated, service_role;
revoke all on all functions in schema pj_private from public;
grant execute on all functions in schema pj_private to authenticated, service_role;

-- people: managers manage everyone; staff see their own row
create policy pj_people_select on public.pj_people for select to authenticated
  using ((select pj_private.is_manager()) or user_id = (select auth.uid()));
create policy pj_people_insert on public.pj_people for insert to authenticated
  with check ((select pj_private.is_manager()));
create policy pj_people_update on public.pj_people for update to authenticated
  using ((select pj_private.is_manager())) with check ((select pj_private.is_manager()));
create policy pj_people_delete on public.pj_people for delete to authenticated
  using ((select pj_private.is_manager()));

-- settings
create policy pj_settings_select on public.pj_settings for select to authenticated
  using ((select pj_private.me()) is not null);
create policy pj_settings_update on public.pj_settings for update to authenticated
  using ((select pj_private.is_manager())) with check ((select pj_private.is_manager()));

-- jobs: managers everything; staff read their own (they change them through the functions in section 5)
create policy pj_jobs_select on public.pj_jobs for select to authenticated
  using ((select pj_private.is_manager()) or assigned_to = (select pj_private.me()));
create policy pj_jobs_insert on public.pj_jobs for insert to authenticated
  with check ((select pj_private.is_manager()));
create policy pj_jobs_update on public.pj_jobs for update to authenticated
  using ((select pj_private.is_manager())) with check ((select pj_private.is_manager()));
create policy pj_jobs_delete on public.pj_jobs for delete to authenticated
  using ((select pj_private.is_manager()));

-- tasks and parts
create policy pj_tasks_select on public.pj_job_tasks for select to authenticated
  using (pj_private.can_see_job(job_id));
create policy pj_tasks_insert on public.pj_job_tasks for insert to authenticated
  with check ((select pj_private.is_manager()));
create policy pj_tasks_update on public.pj_job_tasks for update to authenticated
  using ((select pj_private.is_manager())) with check ((select pj_private.is_manager()));
create policy pj_tasks_delete on public.pj_job_tasks for delete to authenticated
  using ((select pj_private.is_manager()));

create policy pj_parts_select on public.pj_job_parts for select to authenticated
  using (pj_private.can_see_job(job_id));
create policy pj_parts_insert on public.pj_job_parts for insert to authenticated
  with check ((select pj_private.is_manager()));
create policy pj_parts_update on public.pj_job_parts for update to authenticated
  using ((select pj_private.is_manager())) with check ((select pj_private.is_manager()));
create policy pj_parts_delete on public.pj_job_parts for delete to authenticated
  using ((select pj_private.is_manager()));

-- photos: anyone who can see the job can add one; managers or the uploader can remove it
create policy pj_photos_select on public.pj_job_photos for select to authenticated
  using (pj_private.can_see_job(job_id));
create policy pj_photos_insert on public.pj_job_photos for insert to authenticated
  with check (pj_private.can_see_job(job_id) and uploaded_by = (select pj_private.me())
              and path like job_id::text || '/%');
create policy pj_photos_delete on public.pj_job_photos for delete to authenticated
  using ((select pj_private.is_manager()) or uploaded_by = (select pj_private.me()));

-- WhatsApp log: managers only
create policy pj_wa_log_select on public.pj_wa_log for select to authenticated
  using ((select pj_private.is_manager()));

-- WhatsApp numbers: managers only
create policy pj_wa_numbers_select on public.pj_wa_numbers for select to authenticated using ((select pj_private.is_manager()));
create policy pj_wa_numbers_insert on public.pj_wa_numbers for insert to authenticated with check ((select pj_private.is_manager()));
create policy pj_wa_numbers_update on public.pj_wa_numbers for update to authenticated using ((select pj_private.is_manager())) with check ((select pj_private.is_manager()));
create policy pj_wa_numbers_delete on public.pj_wa_numbers for delete to authenticated using ((select pj_private.is_manager()));

-- ---------------------------------------------------------------- 5. Functions the app calls
-- Sign-in: link this login to its row in pj_people. The very first person to sign in becomes the manager.
create function public.pj_claim(p_timezone text default null) returns public.pj_people
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_name text;
  r public.pj_people;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select lower(u.email),
         coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), split_part(u.email, '@', 1))
    into v_email, v_name
    from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then return null; end if;

  select * into r from public.pj_people where user_id = v_uid;
  if found then
    if r.active then return r; end if;
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('pj_claim'));
  if not exists (select 1 from public.pj_people) then
    insert into public.pj_people (user_id, email, name, role)
      values (v_uid, v_email, v_name, 'manager') returning * into r;
    if p_timezone is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
      update public.pj_settings set timezone = p_timezone where id;
    end if;
    return r;
  end if;

  update public.pj_people set user_id = v_uid
    where email = v_email and user_id is null and active returning * into r;
  if found then return r; end if;
  return null;
end $$;

-- Managers: create or change a job with its task and parts lists in one go.
create function public.pj_job_save(p jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_tasks jsonb := coalesce(p->'tasks', '[]'::jsonb);
  v_parts jsonb := coalesce(p->'parts', '[]'::jsonb);
begin
  if not pj_private.is_manager() then raise exception 'Managers only'; end if;
  if v_id is null then
    insert into public.pj_jobs (title, description, customer_name, customer_phone, address, due_date,
                                priority, assigned_to, created_by, source)
    values (trim(p->>'title'), coalesce(p->>'description', ''), coalesce(p->>'customer_name', ''),
            coalesce(p->>'customer_phone', ''), coalesce(p->>'address', ''), nullif(p->>'due_date', '')::date,
            coalesce(nullif(p->>'priority', ''), 'normal'), nullif(p->>'assigned_to', '')::uuid,
            pj_private.me(), 'app')
    returning id into v_id;
  else
    update public.pj_jobs set
      title = trim(p->>'title'),
      description = coalesce(p->>'description', ''),
      customer_name = coalesce(p->>'customer_name', ''),
      customer_phone = coalesce(p->>'customer_phone', ''),
      address = coalesce(p->>'address', ''),
      due_date = nullif(p->>'due_date', '')::date,
      priority = coalesce(nullif(p->>'priority', ''), 'normal'),
      assigned_to = nullif(p->>'assigned_to', '')::uuid
    where id = v_id;
    if not found then raise exception 'Job not found'; end if;
  end if;

  delete from public.pj_job_tasks t where t.job_id = v_id
    and not exists (select 1 from jsonb_array_elements(v_tasks) e where nullif(e->>'id', '')::uuid = t.id);
  update public.pj_job_tasks t set title = trim(e.value->>'title'), sort = e.ordinality
    from jsonb_array_elements(v_tasks) with ordinality e
    where t.job_id = v_id and t.id = nullif(e.value->>'id', '')::uuid
      and trim(coalesce(e.value->>'title', '')) <> '';
  insert into public.pj_job_tasks (job_id, title, sort)
    select v_id, trim(e.value->>'title'), e.ordinality
    from jsonb_array_elements(v_tasks) with ordinality e
    where nullif(e.value->>'id', '') is null and trim(coalesce(e.value->>'title', '')) <> '';

  delete from public.pj_job_parts t where t.job_id = v_id
    and not exists (select 1 from jsonb_array_elements(v_parts) e where nullif(e->>'id', '')::uuid = t.id);
  update public.pj_job_parts t set name = trim(e.value->>'name'),
      qty = coalesce(nullif(e.value->>'qty', '')::numeric, 1), sort = e.ordinality
    from jsonb_array_elements(v_parts) with ordinality e
    where t.job_id = v_id and t.id = nullif(e.value->>'id', '')::uuid
      and trim(coalesce(e.value->>'name', '')) <> '';
  insert into public.pj_job_parts (job_id, name, qty, sort)
    select v_id, trim(e.value->>'name'), coalesce(nullif(e.value->>'qty', '')::numeric, 1), e.ordinality
    from jsonb_array_elements(v_parts) with ordinality e
    where nullif(e.value->>'id', '') is null and trim(coalesce(e.value->>'name', '')) <> '';

  return v_id;
end $$;

-- Staff: start, finish or reopen a job that is assigned to them, and leave completion notes.
create function public.pj_job_progress(p_job uuid, p_status text, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := pj_private.me();
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  if p_status not in ('open', 'in_progress', 'done') then raise exception 'Unknown status'; end if;
  update public.pj_jobs set status = p_status, completion_notes = coalesce(p_notes, completion_notes)
    where id = p_job and status <> 'cancelled'
      and (assigned_to = v_me or pj_private.is_manager());
  if not found then raise exception 'This job is not assigned to you'; end if;
end $$;

create function public.pj_task_done(p_task uuid, p_done boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.pj_job_tasks t set done = p_done
    where t.id = p_task and pj_private.can_see_job(t.job_id);
  if not found then raise exception 'This job is not assigned to you'; end if;
end $$;

create function public.pj_part_used(p_part uuid, p_used boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.pj_job_parts t set used = p_used
    where t.id = p_part and pj_private.can_see_job(t.job_id);
  if not found then raise exception 'This job is not assigned to you'; end if;
end $$;

-- Server only (the whatsapp-webhook function): turn a parsed message into a job.
create function public.pj_wa_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_log uuid;
  v_mgr uuid := nullif(p->>'manager_id', '')::uuid;
  v_from text := nullif(p->>'from_phone', '');
  v_allowed boolean := coalesce((p->>'trusted')::boolean, false) or v_mgr is not null;
  v_person uuid;
  v_role text;
  v_title text := trim(coalesce(p->>'title', ''));
  v_assign text := nullif(trim(coalesce(p->>'assign', '')), '');
  v_like text;
  v_ids uuid[];
  v_assignee uuid;
  v_assignee_name text;
  v_job uuid;
  v_ref integer;
  v_due date := nullif(p->>'due_date', '')::date;
  v_priority text := coalesce(nullif(p->>'priority', ''), 'normal');
begin
  insert into public.pj_wa_log (wa_id, from_phone, body, source)
    values (nullif(p->>'wa_id', ''), v_from, p->>'body', coalesce(nullif(p->>'source', ''), 'whatsapp'))
    on conflict (wa_id) do nothing returning id into v_log;
  if v_log is null then return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;

  -- who is this? a manager's own number, or a number on the approved list
  if v_mgr is null and v_from is not null then
    select id, role into v_person, v_role from public.pj_people
      where phone = v_from and active order by (role = 'manager') desc limit 1;
    if v_role = 'manager' then v_allowed := true; end if;
    if exists (select 1 from public.pj_wa_numbers where phone = v_from and can_create) then v_allowed := true; end if;
    v_mgr := v_person;
  end if;
  if not v_allowed then
    update public.pj_wa_log set result = 'Ignored: this number is not allowed to create jobs' where id = v_log;
    return jsonb_build_object('ok', false, 'reason', 'not_manager');
  end if;
  if v_title = '' then
    update public.pj_wa_log set result = 'Ignored: no job title' where id = v_log;
    return jsonb_build_object('ok', false, 'reason', 'no_title');
  end if;
  if v_priority not in ('low', 'normal', 'high', 'urgent') then v_priority := 'normal'; end if;

  if v_assign is not null then
    v_like := replace(replace(replace(lower(v_assign), '\', '\\'), '%', '\%'), '_', '\_');
    select array_agg(id) into v_ids from public.pj_people where active and lower(name) = lower(v_assign);
    if v_ids is null then
      select array_agg(id) into v_ids from public.pj_people where active and lower(name) like v_like || '%';
    end if;
    if v_ids is null then
      select array_agg(id) into v_ids from public.pj_people where active and lower(name) like '%' || v_like || '%';
    end if;
    if cardinality(v_ids) = 1 then
      v_assignee := v_ids[1];
      select name into v_assignee_name from public.pj_people where id = v_assignee;
    end if;
  end if;

  insert into public.pj_jobs (title, description, customer_name, customer_phone, address, due_date,
                              priority, assigned_to, created_by, source)
  values (v_title, coalesce(p->>'description', ''), coalesce(p->>'customer_name', ''),
          coalesce(p->>'customer_phone', ''), coalesce(p->>'address', ''), v_due, v_priority,
          v_assignee, v_mgr, case when coalesce(p->>'source', '') = 'quick' then 'app' else 'whatsapp' end)
  returning id, ref into v_job, v_ref;

  insert into public.pj_job_tasks (job_id, title, sort)
    select v_job, trim(e.value), e.ordinality
    from jsonb_array_elements_text(coalesce(p->'tasks', '[]'::jsonb)) with ordinality e
    where trim(e.value) <> '';
  insert into public.pj_job_parts (job_id, name, qty, sort)
    select v_job, trim(e.value->>'name'),
           case when coalesce(nullif(e.value->>'qty', '')::numeric, 1) > 0
                then coalesce(nullif(e.value->>'qty', '')::numeric, 1) else 1 end,
           e.ordinality
    from jsonb_array_elements(coalesce(p->'parts', '[]'::jsonb)) with ordinality e
    where trim(coalesce(e.value->>'name', '')) <> '';

  update public.pj_wa_log set job_id = v_job, result = 'Created J-' || lpad(v_ref::text, 4, '0') where id = v_log;

  return jsonb_build_object('ok', true, 'job_id', v_job, 'ref', v_ref, 'title', v_title,
    'assignee', v_assignee_name, 'assign_unmatched', (v_assign is not null and v_assignee is null),
    'assign_asked', v_assign, 'due_date', v_due, 'priority', v_priority,
    'tasks', (select count(*) from public.pj_job_tasks where job_id = v_job),
    'parts', (select count(*) from public.pj_job_parts where job_id = v_job));
end $$;

revoke all on function public.pj_claim(text), public.pj_job_save(jsonb), public.pj_job_progress(uuid, text, text),
  public.pj_task_done(uuid, boolean), public.pj_part_used(uuid, boolean), public.pj_wa_ingest(jsonb) from public, anon;
-- Supabase grants new public functions to signed-in users by default; pj_wa_ingest is for the server only.
revoke all on function public.pj_wa_ingest(jsonb) from authenticated;
grant execute on function public.pj_claim(text), public.pj_job_save(jsonb), public.pj_job_progress(uuid, text, text),
  public.pj_task_done(uuid, boolean), public.pj_part_used(uuid, boolean) to authenticated;
grant execute on function public.pj_wa_ingest(jsonb) to service_role;

-- ---------------------------------------------------------------- 6. Photos (private file storage)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('job-photos', 'job-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;

create policy pj_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and pj_private.can_see_job_path(name));
create policy pj_photos_add on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and pj_private.can_see_job_path(name));
create policy pj_photos_remove on storage.objects for delete to authenticated
  using (bucket_id = 'job-photos' and (select pj_private.is_manager()));

-- ---------------------------------------------------------------- 7. Live updates
alter publication supabase_realtime add table public.pj_jobs, public.pj_job_tasks, public.pj_job_parts, public.pj_job_photos;
