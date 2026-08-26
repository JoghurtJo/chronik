-- ============================================================
-- CHRONIK — Einrichtung der Datenbank (Version 4)
-- ============================================================
-- Einmal komplett kopieren, in Supabase unter "SQL Editor"
-- einfügen, RUN klicken. Das Skript verträgt Wiederholung:
-- Du kannst es jederzeit erneut ausführen.
--
-- Es legt an:
--   profiles        wer ist wer (+ gesperrt ja/nein)
--   events          die Ereignisse (mit Sichtbarkeit)
--   comments        Kommentare zu Bildern
--   event_history   Verlauf: jede Änderung wird mitgeschrieben,
--                   damit du sie rückgängig machen kannst
--   usage_day /     Zähler, damit die Gratis-Grenzen von
--   usage_month /   Supabase und Cloudflare nicht überschritten
--   storage_state   werden
--   bilder          Ersatz-Bildspeicher (falls kein Cloudflare R2)
-- ============================================================

-- ---------- 1. Personen ----------
create table if not exists public.profiles (
  id       uuid primary key references auth.users on delete cascade,
  username text unique,
  email    text,
  role     text not null default 'member',
  blocked  boolean not null default false,
  created  timestamptz not null default now()
);
alter table public.profiles add column if not exists blocked boolean not null default false;
alter table public.profiles enable row level security;

drop policy if exists "profile lesen" on public.profiles;
create policy "profile lesen" on public.profiles
  for select to authenticated using (true);

drop policy if exists "inhaber pflegt profile" on public.profiles;
create policy "inhaber pflegt profile" on public.profiles
  for update to authenticated using (
    id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  );

-- Hilfsfragen, die die Regeln unten benutzen
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner');
$$;

create or replace function public.is_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select blocked from public.profiles where id = auth.uid()), false);
$$;

-- Beim Registrieren automatisch ein Profil anlegen.
-- Das erste Konto wird Inhaber.
create or replace function public.on_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, email, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1)),
    lower(new.email),
    case when (select count(*) from public.profiles) = 0 then 'owner' else 'member' end
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_new_user on auth.users;
create trigger on_new_user after insert on auth.users
  for each row execute function public.on_new_user();

-- Ist diese E-Mail schon vergeben? (Damit die Chronik das sagen kann,
-- ohne die Kontoliste herauszugeben.)
create or replace function public.email_taken(p_email text) returns boolean
language sql security definer set search_path = public, auth as $$
  select exists (select 1 from auth.users where lower(email) = lower(trim(p_email)));
$$;
revoke all on function public.email_taken(text) from public;
grant execute on function public.email_taken(text) to anon, authenticated;

-- ---------- 2. Ereignisse ----------
create table if not exists public.events (
  id       uuid primary key default gen_random_uuid(),
  owner    uuid not null default auth.uid() references auth.users on delete cascade,
  name     text not null default '',
  date     date,
  end_date date,
  place    text default '',
  kicker   text default '',
  vis      text not null default 'public',   -- public | selected | private
  who      uuid[] not null default '{}',
  share    text not null default 'view',     -- view | comment | edit
  data     jsonb not null default '{}',
  created  timestamptz not null default now(),
  changed  timestamptz not null default now(),
  changed_by uuid
);
alter table public.events add column if not exists changed timestamptz not null default now();
alter table public.events add column if not exists changed_by uuid;
create index if not exists events_date_idx on public.events (date);
alter table public.events enable row level security;

drop policy if exists "ereignisse sehen" on public.events;
create policy "ereignisse sehen" on public.events
  for select to authenticated using (
    owner = auth.uid()
    or public.is_owner()
    or (not public.is_blocked() and (
      vis = 'public' or (vis = 'selected' and auth.uid() = any (who))
    ))
  );

drop policy if exists "ereignis anlegen" on public.events;
create policy "ereignis anlegen" on public.events
  for insert to authenticated with check (owner = auth.uid() and not public.is_blocked());

drop policy if exists "ereignis aendern" on public.events;
create policy "ereignis aendern" on public.events
  for update to authenticated using (
    not public.is_blocked() and (
      owner = auth.uid()
      or public.is_owner()
      or (share = 'edit' and (vis = 'public' or (vis = 'selected' and auth.uid() = any (who))))
    )
  );

drop policy if exists "ereignis loeschen" on public.events;
create policy "ereignis loeschen" on public.events
  for delete to authenticated using (
    (owner = auth.uid() and not public.is_blocked()) or public.is_owner()
  );

-- ---------- 3. Kommentare ----------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events on delete cascade,
  author      uuid not null default auth.uid() references public.profiles on delete cascade,
  image_index int not null default 0,
  text        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists comments_event_idx on public.comments (event_id);
alter table public.comments enable row level security;

drop policy if exists "kommentare sehen" on public.comments;
create policy "kommentare sehen" on public.comments
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id)
  );

drop policy if exists "kommentar schreiben" on public.comments;
create policy "kommentar schreiben" on public.comments
  for insert to authenticated with check (
    author = auth.uid() and not public.is_blocked()
    and exists (
      select 1 from public.events e
      where e.id = event_id
        and (e.owner = auth.uid() or e.share in ('comment', 'edit'))
    )
  );

drop policy if exists "kommentar loeschen" on public.comments;
create policy "kommentar loeschen" on public.comments
  for delete to authenticated using (author = auth.uid() or public.is_owner());

-- ---------- 4. Verlauf (Rückgängig machen) ----------
create table if not exists public.event_history (
  id        bigserial primary key,
  event_id  uuid not null,
  action    text not null,               -- update | delete
  actor     uuid,                        -- wer hat geändert
  at        timestamptz not null default now(),
  snapshot  jsonb not null,              -- Zustand VOR der Änderung
  undone    boolean not null default false
);
create index if not exists history_at_idx on public.event_history (at desc);
alter table public.event_history enable row level security;

drop policy if exists "verlauf lesen" on public.event_history;
create policy "verlauf lesen" on public.event_history
  for select to authenticated using (
    public.is_owner() or (snapshot->>'owner')::uuid = auth.uid()
  );

drop policy if exists "verlauf pflegen" on public.event_history;
create policy "verlauf pflegen" on public.event_history
  for update to authenticated using (public.is_owner());

create or replace function public.log_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.event_history (event_id, action, actor, snapshot)
  values (old.id, lower(tg_op), auth.uid(), to_jsonb(old));
  if tg_op = 'UPDATE' then
    new.changed := now();
    new.changed_by := auth.uid();
    return new;
  end if;
  return old;
end; $$;

drop trigger if exists log_event_update on public.events;
create trigger log_event_update before update on public.events
  for each row execute function public.log_event_change();

drop trigger if exists log_event_delete on public.events;
create trigger log_event_delete before delete on public.events
  for each row execute function public.log_event_change();

-- Eine Änderung zurücknehmen (nur Inhaber). Stellt den alten Zustand
-- wieder her — auch bei gelöschten Ereignissen.
create or replace function public.undo_change(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare h public.event_history; s jsonb;
begin
  if not public.is_owner() then raise exception 'Nur die Inhaberin oder der Inhaber darf das.'; end if;
  select * into h from public.event_history where id = p_id;
  if h is null then raise exception 'Diesen Verlaufseintrag gibt es nicht.'; end if;
  s := h.snapshot;

  insert into public.events (id, owner, name, date, end_date, place, kicker, vis, who, share, data, created)
  values (
    (s->>'id')::uuid, (s->>'owner')::uuid, coalesce(s->>'name',''),
    nullif(s->>'date','')::date, nullif(s->>'end_date','')::date,
    coalesce(s->>'place',''), coalesce(s->>'kicker',''),
    coalesce(s->>'vis','public'),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(s->'who','[]'::jsonb)) x), '{}'),
    coalesce(s->>'share','view'), coalesce(s->'data','{}'::jsonb),
    coalesce(nullif(s->>'created','')::timestamptz, now())
  )
  on conflict (id) do update set
    name = excluded.name, date = excluded.date, end_date = excluded.end_date,
    place = excluded.place, kicker = excluded.kicker, vis = excluded.vis,
    who = excluded.who, share = excluded.share, data = excluded.data;

  update public.event_history set undone = true where id = p_id;
end; $$;
grant execute on function public.undo_change(bigint) to authenticated;

-- Person sperren / entsperren (nur Inhaber)
create or replace function public.set_blocked(p_user uuid, p_blocked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Nur die Inhaberin oder der Inhaber darf das.'; end if;
  update public.profiles set blocked = p_blocked where id = p_user and role <> 'owner';
end; $$;
grant execute on function public.set_blocked(uuid, boolean) to authenticated;

-- ---------- 5. Verbrauchszähler (Gratis-Grenzen) ----------
create table if not exists public.usage_day (
  day     date primary key default current_date,
  writes  bigint not null default 0,
  reads   bigint not null default 0,
  uploads bigint not null default 0,
  gets    bigint not null default 0,
  emails  bigint not null default 0
);
create table if not exists public.usage_month (
  ym      text primary key,
  writes  bigint not null default 0,
  reads   bigint not null default 0,
  uploads bigint not null default 0,
  gets    bigint not null default 0,
  bytes_out bigint not null default 0,
  emails  bigint not null default 0
);
create table if not exists public.storage_state (
  id    int primary key default 1,
  bytes bigint not null default 0
);
insert into public.storage_state (id, bytes) values (1, 0) on conflict (id) do nothing;

alter table public.usage_day enable row level security;
alter table public.usage_month enable row level security;
alter table public.storage_state enable row level security;

drop policy if exists "zaehler lesen tag" on public.usage_day;
create policy "zaehler lesen tag" on public.usage_day for select to authenticated using (true);
drop policy if exists "zaehler lesen monat" on public.usage_month;
create policy "zaehler lesen monat" on public.usage_month for select to authenticated using (true);
drop policy if exists "speicher lesen" on public.storage_state;
create policy "speicher lesen" on public.storage_state for select to authenticated using (true);

create or replace function public.bump_usage(
  p_writes bigint default 0, p_reads bigint default 0,
  p_uploads bigint default 0, p_gets bigint default 0,
  p_bytes bigint default 0, p_bytes_out bigint default 0,
  p_emails bigint default 0
) returns void language plpgsql security definer set search_path = public as $$
declare m text := to_char(now(), 'YYYY-MM');
begin
  insert into public.usage_day (day, writes, reads, uploads, gets, emails)
  values (current_date, p_writes, p_reads, p_uploads, p_gets, p_emails)
  on conflict (day) do update set
    writes = usage_day.writes + p_writes,
    reads  = usage_day.reads + p_reads,
    uploads = usage_day.uploads + p_uploads,
    gets   = usage_day.gets + p_gets,
    emails = usage_day.emails + p_emails;

  insert into public.usage_month (ym, writes, reads, uploads, gets, bytes_out, emails)
  values (m, p_writes, p_reads, p_uploads, p_gets, p_bytes_out, p_emails)
  on conflict (ym) do update set
    writes = usage_month.writes + p_writes,
    reads  = usage_month.reads + p_reads,
    uploads = usage_month.uploads + p_uploads,
    gets   = usage_month.gets + p_gets,
    bytes_out = usage_month.bytes_out + p_bytes_out,
    emails = usage_month.emails + p_emails;

  if p_bytes <> 0 then
    update public.storage_state set bytes = greatest(0, bytes + p_bytes) where id = 1;
  end if;
end; $$;
grant execute on function public.bump_usage(bigint, bigint, bigint, bigint, bigint, bigint, bigint) to authenticated;

-- Alles, was die Chronik zum Prüfen der Grenzen braucht — ein Aufruf.
create or replace function public.usage_snapshot() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'day', to_jsonb(coalesce((select d from public.usage_day d where d.day = current_date),
                             row(current_date,0,0,0,0,0)::public.usage_day)),
    'month', to_jsonb(coalesce((select m from public.usage_month m where m.ym = to_char(now(),'YYYY-MM')),
                               row(to_char(now(),'YYYY-MM'),0,0,0,0,0,0)::public.usage_month)),
    'bytes', (select bytes from public.storage_state where id = 1),
    'rows', (select count(*) from public.events),
    'today', current_date,
    'month_end', (date_trunc('month', now()) + interval '1 month')::date
  );
$$;
grant execute on function public.usage_snapshot() to authenticated;

-- ---------- 6. Ersatz-Bildspeicher (wenn kein Cloudflare R2) ----------
insert into storage.buckets (id, name, public)
values ('bilder', 'bilder', false)
on conflict (id) do nothing;

drop policy if exists "bilder hochladen" on storage.objects;
create policy "bilder hochladen" on storage.objects
  for insert to authenticated with check (bucket_id = 'bilder' and not public.is_blocked());

drop policy if exists "bilder ansehen" on storage.objects;
create policy "bilder ansehen" on storage.objects
  for select to authenticated using (bucket_id = 'bilder');

drop policy if exists "eigene bilder loeschen" on storage.objects;
create policy "eigene bilder loeschen" on storage.objects
  for delete to authenticated using (bucket_id = 'bilder' and (owner = auth.uid() or public.is_owner()));

-- ---------- 7. Live-Aktualisierung ----------
do $$
begin
  begin alter publication supabase_realtime add table public.events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.comments; exception when duplicate_object then null; end;
end $$;

-- Fertig. Zurück zur Anleitung.
