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
