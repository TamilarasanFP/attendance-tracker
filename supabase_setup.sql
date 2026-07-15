-- ============================================================
-- Attendance Tracker — Supabase setup
-- Run this in your Supabase project:  SQL Editor -> New query -> paste -> Run
-- ============================================================

-- 1) Employee roster
create table if not exists public.employees (
  emp_id     text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

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
  created_at  timestamptz not null default now()
);
create index if not exists records_date_idx on public.records(date);
create index if not exists records_emp_idx  on public.records(emp_id);

-- 3) Lock the tables down. The server uses the service_role key, which bypasses
--    RLS. Enabling RLS with NO policies means the anon/public key can read
--    nothing — so even if someone got your anon key, the data stays private.
alter table public.employees enable row level security;
alter table public.records   enable row level security;

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
