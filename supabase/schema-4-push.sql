-- Proview Jobs, part 4: notifications on phones (web push). Run after schema-3-wa-bundles.sql.
-- A phone that turns notifications on is remembered here; the database then tells the "push"
-- function whenever a job is created, assigned or completed.

create extension if not exists pg_net;

-- One row per phone or browser that asked for notifications.
create table public.pj_push_subs (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.pj_people(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) < 2000),
  p256dh text not null check (length(p256dh) between 40 and 200),
  auth text not null check (length(auth) between 10 and 100),
  ua text not null default '',
  created_at timestamptz not null default now()
);
create index pj_push_subs_person_idx on public.pj_push_subs (person_id);
alter table public.pj_push_subs enable row level security;
revoke all on public.pj_push_subs from anon, authenticated;
grant all on public.pj_push_subs to service_role;

-- Things only the server may read: the secret the database shows the push function, and the push keys.
create table pj_private.pj_secrets (key text primary key, value text not null);
alter table pj_private.pj_secrets enable row level security;
revoke all on pj_private.pj_secrets from public, anon, authenticated;
insert into pj_private.pj_secrets (key, value)
  values ('push_hook', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (key) do nothing;
-- Where the push function lives. Change this if the project moves.
insert into pj_private.pj_secrets (key, value)
  values ('push_url', 'https://tvakgaafkkfealhmebpm.supabase.co/functions/v1/push')
  on conflict (key) do nothing;

-- This phone wants notifications for the signed-in person.
create function public.pj_push_save(p_endpoint text, p_p256dh text, p_auth text, p_ua text default '') returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := (select pj_private.me());
begin
  if v_me is null then raise exception 'Sign in first'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://[a-z0-9.-]+\.(push\.apple\.com|googleapis\.com|mozilla\.com|windows\.com)/' then
    raise exception 'This browser''s notification service is not supported';
  end if;
  insert into public.pj_push_subs (person_id, endpoint, p256dh, auth, ua)
    values (v_me, p_endpoint, p_p256dh, p_auth, left(coalesce(p_ua, ''), 300))
    on conflict (endpoint) do update set person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua;
  -- a person keeps at most 10 devices; the oldest drop off
  delete from public.pj_push_subs where person_id = v_me and id not in
    (select id from public.pj_push_subs where person_id = v_me order by created_at desc limit 10);
  return true;
end $$;

-- This phone no longer wants them (also used on sign-out).
create function public.pj_push_remove(p_endpoint text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.pj_push_subs where endpoint = p_endpoint and person_id = (select pj_private.me());
  return true;
end $$;

-- Server only: what the push function needs.
create function public.pj_push_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'hook', (select value from pj_private.pj_secrets where key = 'push_hook'),
    'vapid', (select value::jsonb from pj_private.pj_secrets where key = 'push_vapid'))
$$;
-- Server only: keep the push keys the first time they are made, and hand back whichever set was kept.
create function public.pj_push_keys(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p->>'publicKey', '') = '' or p->'privateJwk' is null then raise exception 'bad keys'; end if;
  insert into pj_private.pj_secrets (key, value) values ('push_vapid', p::text) on conflict (key) do nothing;
  return (select value::jsonb from pj_private.pj_secrets where key = 'push_vapid');
end $$;

revoke all on function public.pj_push_save(text, text, text, text), public.pj_push_remove(text),
  public.pj_push_config(), public.pj_push_keys(jsonb) from public, anon, authenticated;
grant execute on function public.pj_push_save(text, text, text, text), public.pj_push_remove(text) to authenticated;
grant execute on function public.pj_push_config(), public.pj_push_keys(jsonb) to service_role;

-- Tell the push function when a job is created, given to someone, or completed.
-- The call is queued and sent after the change is saved; a failure here never blocks the job.
create function pj_private.push_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_event text; v_url text; v_hook text;
begin
  if tg_op = 'INSERT' then v_event := 'created';
  elsif new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then v_event := 'assigned';
  elsif new.status = 'done' and old.status is distinct from 'done' then v_event := 'done';
  else return new;
  end if;
  begin
    select value into v_url from pj_private.pj_secrets where key = 'push_url';
    select value into v_hook from pj_private.pj_secrets where key = 'push_hook';
    if v_url is not null and v_hook is not null then
      perform net.http_post(url := v_url,
        body := jsonb_build_object('job_id', new.id, 'event', v_event, 'actor', (select pj_private.me())),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-pj-hook', v_hook),
        timeout_milliseconds := 10000);
    end if;
  exception when others then null;
  end;
  return new;
end $$;
revoke all on function pj_private.push_event() from public, anon, authenticated;
create trigger pj_jobs_push after insert or update of assigned_to, status on public.pj_jobs
  for each row execute function pj_private.push_event();
