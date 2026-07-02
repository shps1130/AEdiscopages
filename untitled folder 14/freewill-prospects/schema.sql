-- FreeWill Prospects — Supabase schema
-- Run this in the Supabase SQL editor of a NEW project (don't reuse the TSR project).

-- ============================================================
-- PAGES: one row per prospect page (draft or published)
-- ============================================================
create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  slug text unique,                          -- e.g. 'jesuit-portland'; set at publish time
  org_name text not null,
  vertical text not null,                    -- catholic | evangelical | k12 | higher-ed | rescue-mission | media-ministry | mainline | other
  status text not null default 'draft',      -- draft | published | archived
  html text,                                 -- the generated single-file page
  brief jsonb,                               -- structured prospect brief from transcript extraction
  form_inputs jsonb,                         -- what the AE typed into the form
  created_by text,                           -- AE name/email
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists pages_slug_idx on pages (slug) where status = 'published';
create index if not exists pages_status_idx on pages (status, updated_at desc);

-- ============================================================
-- ASSETS: the FreeWill knowledge base (marketing owns this)
-- ============================================================
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  asset_type text not null,                  -- case_study | video | one_pager | stat | logo | faq
  url text,                                  -- link to video, PDF, logo image, etc.
  summary text not null,                     -- 2-4 sentence description Claude uses to decide relevance & write copy
  verticals text[] not null default '{}',    -- which verticals this fits: {'catholic','k12'} etc. Empty = all.
  pain_points text[] not null default '{}',  -- e.g. {'no-pg-program','incumbent-tool','aging-donors','it-concerns','staff-capacity','board-buy-in','fiscal-year'}
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists assets_active_idx on assets (active, asset_type);

-- ============================================================
-- PAGE VIEWS: prospect engagement tracking
-- ============================================================
create table if not exists page_views (
  id bigint generated always as identity primary key,
  page_id uuid not null references pages(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  referrer text,
  user_agent text
);

create index if not exists page_views_page_idx on page_views (page_id, viewed_at desc);

-- ============================================================
-- SECURITY: lock everything down. All access goes through the
-- Vercel serverless functions using the SERVICE ROLE key.
-- The anon key should never be used by this app.
-- ============================================================
alter table pages enable row level security;
alter table assets enable row level security;
alter table page_views enable row level security;
-- No policies created on purpose: with RLS on and no policies,
-- the anon key can read/write nothing. Service role bypasses RLS.

-- ============================================================
-- RPC used by /p/:slug to bump the counter atomically
-- ============================================================
create or replace function increment_view_count(p_id uuid)
returns void language sql security definer as $$
  update pages set view_count = view_count + 1 where id = p_id;
$$;

-- ============================================================
-- SEED: a few starter assets so generation works on day one.
-- Replace these with real marketing materials via admin.html.
-- ============================================================
insert into assets (title, asset_type, url, summary, verticals, pain_points) values
('Jesuit High School Portland partnership', 'case_study', 'https://REPLACE-ME.example/jesuit-case-study',
 'K-12 Catholic school that launched planned giving with FreeWill alongside an existing advancement program. Strong example of celebratory reframe: great annual giving, untapped legacy giving.', '{k12,catholic}', '{no-pg-program,staff-capacity}'),
('TBN media ministry partnership', 'case_study', 'https://tbn-freewill.netlify.app',
 'Large media ministry using FreeWill to capture legacy gifts from a national broadcast audience of older donors. Good fit when the donor base skews 60+ and gives by mail/phone.', '{media-ministry,evangelical}', '{aging-donors,no-pg-program}'),
('FreeWill alongside PG Calc / Crescendo', 'one_pager', 'https://REPLACE-ME.example/alongside-onepager',
 'Explains how FreeWill complements (not replaces) calculation and marketing tools like PG Calc and Crescendo: FreeWill is the donor-facing completion layer that turns intent into signed wills.', '{}', '{incumbent-tool}'),
('Wealth transfer stat: $124T through 2048', 'stat', null,
 'Cerulli projects $124 trillion transferring between generations through 2048, the largest wealth transfer in history. Frames urgency for building legacy giving infrastructure now.', '{}', '{aging-donors,board-buy-in}'),
('IT & security overview', 'one_pager', 'https://REPLACE-ME.example/it-onepager',
 'Covers data security, SOC 2, no-integration-required deployment, and what IT actually has to do (almost nothing: a link on the website). Written for IT directors and ops leads.', '{}', '{it-concerns}');
