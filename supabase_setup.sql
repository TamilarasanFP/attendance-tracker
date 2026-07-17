-- ============================================================
-- Attendance Tracker — Supabase setup
-- Run this in your Supabase project:  SQL Editor -> New query -> paste -> Run
-- ============================================================

-- 1) Employee roster
create table if not exists public.employees (
  emp_id        text primary key,   -- Associate ID
  name          text not null,
  business_unit text,
  team          text,
  campus        text,
  exited        boolean not null default false,
  exited_at     timestamptz,
  created_at    timestamptz not null default now()
);
-- Migrations for an existing table (safe to re-run):
alter table public.employees add column if not exists exited    boolean not null default false;
alter table public.employees add column if not exists exited_at timestamptz;
alter table public.employees add column if not exists password_hash        text;
alter table public.employees add column if not exists must_change_password  boolean not null default true;

-- Key/value settings (holds the global default user password hash)
create table if not exists public.settings (
  key   text primary key,
  value text
);
alter table public.settings enable row level security;
-- rename old 'vertical' -> 'business_unit' only if that's still the situation
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='employees' and column_name='vertical')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='employees' and column_name='business_unit') then
    alter table public.employees rename column vertical to business_unit;
  end if;
end $$;
alter table public.employees add column if not exists business_unit text;
alter table public.employees add column if not exists team          text;
alter table public.employees add column if not exists campus        text;

-- 2) Attendance records
create table if not exists public.records (
  id          text primary key,          -- <empId>_<date>_<startoftheday|endoftheday>
  emp_id      text not null,
  name        text not null,
  type        text not null check (type in ('start','end')),
  date        text not null,             -- YYYY-MM-DD (local capture date)
  time        text not null,             -- HH:MM:SS  (local capture time)
  captured_at timestamptz,               -- exact moment the photo was taken
  server_time timestamptz,               -- when the server received it
  photo       text,                      -- filename in the storage bucket
  lat         double precision,          -- capture location
  lng         double precision,
  created_at  timestamptz not null default now()
);
create index if not exists records_date_idx on public.records(date);
create index if not exists records_emp_idx  on public.records(emp_id);
-- If the records table already existed, add the location columns:
alter table public.records add column if not exists lat double precision;
alter table public.records add column if not exists lng double precision;

-- 2b) Manual per-day status overrides (Present / Absent / Permission)
create table if not exists public.day_status (
  emp_id     text not null,
  date       text not null,             -- YYYY-MM-DD
  status     text not null check (status in ('present','absent','permission','normal_leave')),
  updated_at timestamptz not null default now(),
  primary key (emp_id, date)
);

-- 2c) Admin-managed dropdown option lists (Business Unit / Team / Campus)
create table if not exists public.options (
  category text not null check (category in ('business_unit','team','campus')),
  value    text not null,
  primary key (category, value)
);
-- (The app seeds default options automatically on first load.)

-- 2c-geo) Per-campus geofence (coordinates + allowed radius in metres)
create table if not exists public.campus_geo (
  campus     text primary key,
  lat        double precision,
  lng        double precision,
  radius_m   integer not null default 200,
  updated_at timestamptz not null default now()
);
alter table public.campus_geo enable row level security;

-- 2d) HelpDesk tickets (employees raise, admins reply)
create table if not exists public.helpdesk (
  id          bigint generated always as identity primary key,
  emp_id      text not null,
  name        text,
  subject     text not null,
  message     text not null,
  status      text not null default 'open' check (status in ('open','resolved')),
  admin_reply text,
  created_at  timestamptz not null default now(),
  replied_at  timestamptz
);
create index if not exists helpdesk_emp_idx    on public.helpdesk(emp_id);
create index if not exists helpdesk_status_idx on public.helpdesk(status);
alter table public.helpdesk add column if not exists category text;
alter table public.helpdesk add column if not exists priority text;
-- allow the "on_hold" status
alter table public.helpdesk drop constraint if exists helpdesk_status_check;
alter table public.helpdesk add constraint helpdesk_status_check check (status in ('open','on_hold','resolved'));
alter table public.helpdesk enable row level security;

-- Conversation thread for tickets
create table if not exists public.helpdesk_messages (
  id         bigint generated always as identity primary key,
  ticket_id  bigint not null,
  sender     text not null check (sender in ('user','admin')),
  message    text not null,
  created_at timestamptz not null default now()
);
create index if not exists helpdesk_messages_ticket_idx on public.helpdesk_messages(ticket_id);
alter table public.helpdesk_messages enable row level security;

-- 2e) Analytics helpers (monthly trends)
create or replace function public.attendance_by_month()
returns table(ym text, days_attended bigint)
language sql stable as $$
  select substring(date,1,7) as ym, count(distinct emp_id || '|' || date) as days_attended
  from public.records
  group by 1 order by 1;
$$;
create or replace function public.tickets_by_month()
returns table(ym text, cnt bigint)
language sql stable as $$
  select to_char(created_at, 'YYYY-MM') as ym, count(*) as cnt
  from public.helpdesk
  group by 1 order by 1;
$$;

-- 3) Lock the tables down. The server uses the service_role key, which bypasses
--    RLS. Enabling RLS with NO policies means the anon/public key can read
--    nothing — so even if someone got your anon key, the data stays private.
alter table public.employees  enable row level security;
alter table public.records    enable row level security;
alter table public.day_status enable row level security;
alter table public.options    enable row level security;

-- ============================================================
-- 4) Storage bucket for photos
--    Easiest: Supabase Dashboard -> Storage -> New bucket
--       name:   attendance-photos
--       public: OFF (keep it private; the server proxies downloads)
--    Or run the SQL below to create it programmatically:
-- ============================================================
insert into storage.buckets (id, name, public)
values ('attendance-photos', 'attendance-photos', false)
on conflict (id) do nothing;

-- No storage policies are needed: the server accesses Storage with the
-- service_role key, which bypasses them. Do NOT make the bucket public.
