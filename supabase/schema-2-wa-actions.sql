-- Proview Jobs, part 2: follow-up actions from WhatsApp buttons and lists (assign, set priority, add details).
-- Run after schema.sql.

create table public.pj_wa_pending (
  phone text primary key,
  job_id uuid not null references public.pj_jobs(id) on delete cascade,
  expires_at timestamptz not null
);
create index pj_wa_pending_job_idx on public.pj_wa_pending (job_id);
alter table public.pj_wa_pending enable row level security;
revoke all on public.pj_wa_pending from anon, authenticated;
grant all on public.pj_wa_pending to service_role;

-- Server only (the whatsapp-webhook function).
create function public.pj_wa_action(p jsonb) returns jsonb
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
begin
  if v_from is null then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  -- the same rule as creating a job: a manager's own number, or a listed number that may create
  if exists (select 1 from public.pj_people where phone = v_from and active and role = 'manager')
     or exists (select 1 from public.pj_wa_numbers where phone = v_from and can_create) then
    v_ok := true;
  end if;
  if not v_ok then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;

  if v_action = 'pending' then
    select job_id into v_job from public.pj_wa_pending where phone = v_from and expires_at > now();
    if v_job is null then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
    return jsonb_build_object('ok', true, 'job_id', v_job);
  end if;

  if v_action = 'details_apply' then
    select job_id into v_job from public.pj_wa_pending where phone = v_from and expires_at > now();
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
      on conflict (phone) do update set job_id = excluded.job_id, expires_at = excluded.expires_at;

  elsif v_action = 'details_apply' then
    -- loose text arrives as "title" plus "description" from the message reader: both are notes here
    v_notes := trim(both E'\n' from concat_ws(E'\n', nullif(trim(coalesce(p->>'title', '')), ''), nullif(trim(coalesce(p->>'description', '')), '')));
    if v_assign is not null then
      v_like := replace(replace(replace(lower(v_assign), '\', '\\'), '%', '\%'), '_', '\_');
      select array_agg(id) into v_ids from public.pj_people where active and lower(name) = lower(v_assign);
      if v_ids is null then select array_agg(id) into v_ids from public.pj_people where active and lower(name) like v_like || '%'; end if;
      if v_ids is null then select array_agg(id) into v_ids from public.pj_people where active and lower(name) like '%' || v_like || '%'; end if;
      if cardinality(v_ids) = 1 then v_person := v_ids[1]; end if;
    end if;
    update public.pj_jobs set
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
    insert into public.pj_wa_log (wa_id, from_phone, body, source, job_id, result)
      values (nullif(p->>'wa_id', ''), v_from, p->>'body', 'whatsapp', j.id, 'Details added to J-' || lpad(j.ref::text, 4, '0'))
      on conflict (wa_id) do nothing;

  else
    return jsonb_build_object('ok', false, 'reason', 'bad_action');
  end if;

  select * into j from public.pj_jobs where id = j.id;
  return jsonb_build_object('ok', true, 'action', v_action, 'job_id', j.id, 'ref', j.ref, 'title', j.title,
    'assignee', (select name from public.pj_people where id = j.assigned_to),
    'assign_unmatched', (v_action = 'details_apply' and v_assign is not null and v_person is null), 'assign_asked', v_assign,
    'due_date', j.due_date, 'priority', j.priority,
    'tasks', (select count(*) from public.pj_job_tasks where job_id = j.id),
    'parts', (select count(*) from public.pj_job_parts where job_id = j.id));
end $$;
revoke all on function public.pj_wa_action(jsonb) from public, anon, authenticated;
grant execute on function public.pj_wa_action(jsonb) to service_role;
