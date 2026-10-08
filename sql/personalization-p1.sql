-- NewsInsight 개인화 P1 : 테이블 생성 + RLS(행 접근 잠금)
-- 실행 위치 : Supabase 대시보드 > SQL Editor > New query 에 통째로 붙여 넣고 Run
-- 여러 번 실행해도 안전하다 (이미 있으면 건너뜀).
--
-- 설계 원칙
--  * 브라우저는 Supabase 테이블을 직접 읽지 않는다. 항상 우리 서버(/api/*)를 거친다.
--    그래서 RLS 를 켜고 정책(policy)은 하나도 만들지 않는다 -> anon / authenticated 키로는 전부 막힌다.
--  * 서버는 service_role 키를 쓰므로 RLS 를 건너뛰고 정상 동작한다.
--  * 사용자 id 는 Supabase 로그인 계정(auth.users)을 가리킨다. 계정이 지워지면 데이터도 같이 지워진다.

-- ---------------------------------------------------------------
-- 1. 허용 사용자 (신청 -> 승인)
-- ---------------------------------------------------------------
create table if not exists public.allowed_users (
  email        text primary key,                       -- 항상 소문자로 저장
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  name         text,
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text,
  constraint allowed_users_email_lower check (email = lower(email))
);

-- ---------------------------------------------------------------
-- 2. 계정별 설정 (키워드는 공용 기본값에서 바꾼 섹션만 저장)
-- ---------------------------------------------------------------
create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  keywords   jsonb not null default '{}'::jsonb,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 3. 개인 AI 키 (서버가 AES-256-GCM 으로 암호화한 값만 저장)
-- ---------------------------------------------------------------
create table if not exists public.user_ai_keys (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  key_cipher text not null,                            -- 암호문. 원문 키는 절대 저장하지 않는다
  key_last4  text not null,                            -- 화면 표시용 끝 4자리
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 4. 좋아요 / 싫어요
-- ---------------------------------------------------------------
create table if not exists public.article_votes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  url_key    text not null,
  vote       smallint not null check (vote in (-1, 1)),
  section    text,
  title      text,
  created_at timestamptz not null default now(),
  primary key (user_id, url_key)
);
create index if not exists article_votes_user_created_idx
  on public.article_votes (user_id, created_at desc);

-- ---------------------------------------------------------------
-- 5. 저장한 기사
-- ---------------------------------------------------------------
create table if not exists public.saved_articles (
  user_id  uuid not null references auth.users (id) on delete cascade,
  url_key  text not null,
  article  jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (user_id, url_key)
);
create index if not exists saved_articles_user_saved_idx
  on public.saved_articles (user_id, saved_at desc);

-- ---------------------------------------------------------------
-- 6. 읽음 표시 (사용자당 최근 1000건은 서버가 정리한다)
-- ---------------------------------------------------------------
create table if not exists public.read_marks (
  user_id uuid not null references auth.users (id) on delete cascade,
  url_key text not null,
  read_at timestamptz not null default now(),
  primary key (user_id, url_key)
);
create index if not exists read_marks_user_read_idx
  on public.read_marks (user_id, read_at desc);

-- ---------------------------------------------------------------
-- 7. RLS 켜기 (기존 app_settings 포함) + 브라우저 키 권한 회수
--    정책을 만들지 않으므로 anon / authenticated 는 아무 행도 못 읽고 못 쓴다.
-- ---------------------------------------------------------------
alter table public.app_settings   enable row level security;
alter table public.allowed_users  enable row level security;
alter table public.user_settings  enable row level security;
alter table public.user_ai_keys   enable row level security;
alter table public.article_votes  enable row level security;
alter table public.saved_articles enable row level security;
alter table public.read_marks     enable row level security;

-- RLS 가 이미 막지만, 권한 자체도 걷어 두면 실수로 정책이 생겨도 한 겹 더 막힌다.
revoke all on public.app_settings   from anon, authenticated;
revoke all on public.allowed_users  from anon, authenticated;
revoke all on public.user_settings  from anon, authenticated;
revoke all on public.user_ai_keys   from anon, authenticated;
revoke all on public.article_votes  from anon, authenticated;
revoke all on public.saved_articles from anon, authenticated;
revoke all on public.read_marks     from anon, authenticated;

-- ---------------------------------------------------------------
-- 8. 확인 : 일곱 줄 모두 rls_on = true 여야 한다
-- ---------------------------------------------------------------
select c.relname as table_name, c.relrowsecurity as rls_on
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('app_settings', 'allowed_users', 'user_settings',
                    'user_ai_keys', 'article_votes', 'saved_articles', 'read_marks')
order by c.relname;

-- ---------------------------------------------------------------
-- 되돌리기 (문제가 생겼을 때만. 필요한 줄만 골라 실행)
--   alter table public.app_settings disable row level security;
--   grant all on public.app_settings to anon, authenticated;   -- 원래 상태로 완전 복구할 때
-- ---------------------------------------------------------------
