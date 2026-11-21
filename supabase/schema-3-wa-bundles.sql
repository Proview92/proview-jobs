-- Proview Jobs, part 3: forwarded messages and photos sent in one go land on ONE job,
-- and the next typed message can name that job. Run after schema-2-wa-actions.sql.

-- What the next typed message from a number is for: extra details, or the job's title.
alter table public.pj_wa_pending add column kind text not null default 'details' check (kind in ('details', 'title'));

-- The job a number is currently forwarding things onto. It stays open for 30 seconds after the last item.
create table public.pj_wa_bundle (
  phone text primary key,
  job_id uuid not null references public.pj_jobs(id) on delete cascade,
  seq integer not null default 1,          -- goes up with every item, so only the last item sends the reply
  texts integer not null default 0,
  photos integer not null default 0,
  titled boolean not null default false,   -- false while the title is only a placeholder
  last_at timestamptz not null default now(),
  menu_at timestamptz                      -- when the "choose staff" reply went out
);
create index pj_wa_bundle_job_idx on public.pj_wa_bundle (job_id);
alter table public.pj_wa_bundle enable row level security;
revoke all on public.pj_wa_bundle from anon, authenticated;
grant all on public.pj_wa_bundle to service_role;

-- One forwarded message or photo arrives. Items from the same number are handled one at a time
-- (a lock per number), so several arriving in the same second still end up on the same job.
-- p.create = false means "only join a job that is already open".  Server only.
create function public.pj_wa_bundle(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from text := nullif(p->>'from_phone', '');
  v_photo boolean := coalesce(p->>'kind', '') = 'photo';
  v_body text := trim(coalesce(p->>'body', ''));
  v_title text := left(trim(coalesce(p->>'title', '')), 200);
  v_create boolean := coalesce((p->>'create')::boolean, true);
  b public.pj_wa_bundle;
  r jsonb;
  v_log uuid;
  v_job uuid;
  v_ref integer;
  v_seq integer;
begin
  if v_from is null or not (
       exists (select 1 from public.pj_people where phone = v_from and active and role = 'manager')
    or exists (select 1 from public.pj_wa_numbers where phone = v_from and can_create)) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pj_wa_bundle:' || v_from, 0));

  select * into b from public.pj_wa_bundle where phone = v_from and last_at > clock_timestamp() - interval '30 seconds';
  if not found then
    if not v_create then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
    r := public.pj_wa_ingest((p - 'trusted' - 'manager_id') || jsonb_build_object(
           'title', coalesce(nullif(v_title, ''), 'Photos sent on WhatsApp'),
           'body', coalesce(nullif(v_body, ''), '(photo)'), 'source', 'whatsapp'));
    if not coalesce((r->>'ok')::boolean, false) then return r; end if;
    v_job := (r->>'job_id')::uuid;
    insert into public.pj_wa_bundle (phone, job_id, seq, texts, photos, titled, last_at, menu_at)
      values (v_from, v_job, 1, case when v_photo then 0 else 1 end, case when v_photo then 1 else 0 end, v_title <> '', clock_timestamp(), null)
      on conflict (phone) do update set job_id = excluded.job_id, seq = 1, texts = excluded.texts, photos = excluded.photos,
        titled = excluded.titled, last_at = excluded.last_at, menu_at = null;
    -- the next typed message from this number names the job
    insert into public.pj_wa_pending (phone, job_id, expires_at, kind) values (v_from, v_job, now() + interval '15 minutes', 'title')
      on conflict (phone) do update set job_id = excluded.job_id, expires_at = excluded.expires_at, kind = 'title';
    return jsonb_build_object('ok', true, 'new', true, 'job_id', v_job, 'ref', (r->>'ref')::integer, 'seq', 1);
  end if;

  select ref into v_ref from public.pj_jobs where id = b.job_id;
  insert into public.pj_wa_log (wa_id, from_phone, body, source, job_id, result)
    values (nullif(p->>'wa_id', ''), v_from, coalesce(nullif(v_body, ''), '(photo)'), 'whatsapp', b.job_id, 'Added to J-' || lpad(v_ref::text, 4, '0'))
    on conflict (wa_id) do nothing returning id into v_log;
  if v_log is null then return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;

  update public.pj_jobs set
    title = case when not b.titled and v_title <> '' then v_title else title end,
    description = case when v_body <> '' then left(trim(both E'\n' from concat_ws(E'\n\n', nullif(description, ''), v_body)), 8000) else description end
  where id = b.job_id;
  update public.pj_wa_bundle set seq = seq + 1, texts = texts + case when v_photo then 0 else 1 end,
    photos = photos + case when v_photo then 1 else 0 end, titled = titled or v_title <> '', last_at = clock_timestamp()
    where phone = v_from returning seq into v_seq;
  update public.pj_wa_pending set expires_at = now() + interval '15 minutes' where phone = v_from and job_id = b.job_id and kind = 'title';
  return jsonb_build_object('ok', true, 'new', false, 'job_id', b.job_id, 'ref', v_ref, 'seq', v_seq);
end $$;
revoke all on function public.pj_wa_bundle(jsonb) from public, anon, authenticated;
grant execute on function public.pj_wa_bundle(jsonb) to service_role;

-- A few seconds after an item: if nothing newer arrived, this is the end of the batch and the reply goes out.
-- Server only.
create function public.pj_wa_bundle_settle(p_phone text, p_seq integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.pj_wa_bundle; j public.pj_jobs; v_first boolean;
begin
  if p_phone is null or not (
       exists (select 1 from public.pj_people where phone = p_phone and active and role = 'manager')
    or exists (select 1 from public.pj_wa_numbers where phone = p_phone and can_create)) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pj_wa_bundle:' || p_phone, 0));
  select * into b from public.pj_wa_bundle where phone = p_phone;
  if not found or b.seq <> p_seq then return jsonb_build_object('ok', false, 'reason', 'moved'); end if;
  select * into j from public.pj_jobs where id = b.job_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_job'); end if;
  v_first := b.menu_at is null;
  update public.pj_wa_bundle set menu_at = clock_timestamp() where phone = p_phone;
  return jsonb_build_object('ok', true, 'first', v_first, 'job_id', j.id, 'ref', j.ref, 'title', j.title,
    'texts', b.texts, 'photos', (select count(*) from public.pj_job_photos where job_id = j.id),
    'needs_title', exists (select 1 from public.pj_wa_pending where phone = p_phone and job_id = j.id and kind = 'title' and expires_at > now()),
    'assignee', (select name from public.pj_people where id = j.assigned_to),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role))
                        from (select id, name, role from public.pj_people where active order by name limit 9) x), '[]'::jsonb));
end $$;
revoke all on function public.pj_wa_bundle_settle(text, integer) from public, anon, authenticated;
grant execute on function public.pj_wa_bundle_settle(text, integer) to service_role;

-- The follow-up actions, now aware of "the next message is the title".
create or replace function public.pj_wa_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from text := nullif(p->>'from_phone', '');
  v_action text := coalesce(p->>'action', '');
  v_job uuid;
  v_ok boolean := false;
  v_person uuid;
  v_text text;
  v_like text;
  v_ids uuid[];
  v_assign text := nullif(trim(coalesce(p->>'assign', '')), '');
  v_notes text;
  v_base integer;
  j public.pj_jobs;
  v_kind text := 'details';
begin
  if v_from is null then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  -- the same rule as creating a job: a manager's own number, or a listed number that may create
  if exists (select 1 from public.pj_people where phone = v_from and active and role = 'manager')
     or exists (select 1 from public.pj_wa_numbers where phone = v_from and can_create) then
    v_ok := true;
  end if;
  if not v_ok then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;

  if v_action = 'pending' then
    select job_id, kind into v_job, v_kind from public.pj_wa_pending where phone = v_from and expires_at > now();
    if v_job is null then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
    return jsonb_build_object('ok', true, 'job_id', v_job, 'kind', v_kind);
  end if;

  if v_action = 'details_apply' then
    select job_id, kind into v_job, v_kind from public.pj_wa_pending where phone = v_from and expires_at > now();
  else
    begin
      v_job := nullif(p->>'job_id', '')::uuid;
    exception when others then
      v_job := null;
    end;
  end if;
  select * into j from public.pj_jobs where id = v_job;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_job'); end if;

  if v_action = 'people' then
    return jsonb_build_object('ok', true, 'job_id', j.id, 'ref', j.ref, 'title', j.title,
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role))
                          from (select id, name, role from public.pj_people where active order by name limit 9) x), '[]'::jsonb));

  elsif v_action = 'assign' then
    begin
      v_person := nullif(p->>'person_id', '')::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'reason', 'no_person');
    end;
    if v_person is not null and not exists (select 1 from public.pj_people where id = v_person and active) then
      return jsonb_build_object('ok', false, 'reason', 'no_person');
    end if;
    update public.pj_jobs set assigned_to = v_person where id = j.id;

  elsif v_action = 'priority' then
    v_text := coalesce(p->>'priority', '');
    if v_text not in ('low', 'normal', 'high', 'urgent') then return jsonb_build_object('ok', false, 'reason', 'bad_value'); end if;
    update public.pj_jobs set priority = v_text where id = j.id;

  elsif v_action = 'details_start' then
    insert into public.pj_wa_pending (phone, job_id, expires_at) values (v_from, j.id, now() + interval '30 minutes')
      on conflict (phone) do update set job_id = excluded.job_id, expires_at = excluded.expires_at, kind = 'details';

  elsif v_action = 'details_apply' then
    -- loose text arrives as "title" plus "description" from the message reader: both are notes here
    -- unless this number was asked for the job's title: then the first line is the title
    v_notes := trim(both E'\n' from concat_ws(E'\n', case when v_kind = 'title' then null else nullif(trim(coalesce(p->>'title', '')), '') end, nullif(trim(coalesce(p->>'description', '')), '')));
    if v_assign is not null then
      v_like := replace(replace(replace(lower(v_assign), '\', '\\'), '%', '\%'), '_', '\_');
      select array_agg(id) into v_ids from public.pj_people where active and lower(name) = lower(v_assign);
      if v_ids is null then select array_agg(id) into v_ids from public.pj_people where active and lower(name) like v_like || '%'; end if;
      if v_ids is null then select array_agg(id) into v_ids from public.pj_people where active and lower(name) like '%' || v_like || '%'; end if;
      if cardinality(v_ids) = 1 then v_person := v_ids[1]; end if;
    end if;
    update public.pj_jobs set
      title = case when v_kind = 'title' and trim(coalesce(p->>'title', '')) <> '' then left(trim(p->>'title'), 200) else title end,
      customer_name = coalesce(nullif(trim(coalesce(p->>'customer_name', '')), ''), customer_name),
      customer_phone = coalesce(nullif(trim(coalesce(p->>'customer_phone', '')), ''), customer_phone),
      address = coalesce(nullif(trim(coalesce(p->>'address', '')), ''), address),
      due_date = coalesce(nullif(p->>'due_date', '')::date, due_date),
      priority = case when coalesce((p->>'priority_set')::boolean, false) and p->>'priority' in ('low', 'normal', 'high', 'urgent') then p->>'priority' else priority end,
      assigned_to = coalesce(v_person, assigned_to),
      description = trim(both E'\n' from concat_ws(E'\n', nullif(description, ''), nullif(v_notes, '')))
    where id = j.id;
    select coalesce(max(sort), 0) into v_base from public.pj_job_tasks where job_id = j.id;
    insert into public.pj_job_tasks (job_id, title, sort)
      select j.id, trim(e.value), v_base + e.ordinality
      from jsonb_array_elements_text(coalesce(p->'tasks', '[]'::jsonb)) with ordinality e where trim(e.value) <> '';
    select coalesce(max(sort), 0) into v_base from public.pj_job_parts where job_id = j.id;
    insert into public.pj_job_parts (job_id, name, qty, sort)
      select j.id, trim(e.value->>'name'),
             case when coalesce(nullif(e.value->>'qty', '')::numeric, 1) > 0 then coalesce(nullif(e.value->>'qty', '')::numeric, 1) else 1 end,
             v_base + e.ordinality
      from jsonb_array_elements(coalesce(p->'parts', '[]'::jsonb)) with ordinality e where trim(coalesce(e.value->>'name', '')) <> '';
    delete from public.pj_wa_pending where phone = v_from;
    if v_kind = 'title' then update public.pj_wa_bundle set titled = true where phone = v_from and job_id = j.id; end if;
    insert into public.pj_wa_log (wa_id, from_phone, body, source, job_id, result)
      values (nullif(p->>'wa_id', ''), v_from, p->>'body', 'whatsapp', j.id, case when v_kind = 'title' then 'Title set for J-' else 'Details added to J-' end || lpad(j.ref::text, 4, '0'))
      on conflict (wa_id) do nothing;

  else
    return jsonb_build_object('ok', false, 'reason', 'bad_action');
  end if;

  select * into j from public.pj_jobs where id = j.id;
  return jsonb_build_object('ok', true, 'action', v_action, 'job_id', j.id, 'ref', j.ref, 'title', j.title,
    'assignee', (select name from public.pj_people where id = j.assigned_to),
    'kind', v_kind, 'assign_unmatched', (v_action = 'details_apply' and v_assign is not null and v_person is null), 'assign_asked', v_assign,
    'due_date', j.due_date, 'priority', j.priority,
    'tasks', (select count(*) from public.pj_job_tasks where job_id = j.id),
    'parts', (select count(*) from public.pj_job_parts where job_id = j.id));
end $$;
revoke all on function public.pj_wa_action(jsonb) from public, anon, authenticated;
grant execute on function public.pj_wa_action(jsonb) to service_role;
