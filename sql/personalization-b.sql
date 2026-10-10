-- NewsInsight 섹션 오분류 B : 관리자가 '이 섹션에 안 맞음'으로 뺀 기사
-- 실행 위치 : Supabase 대시보드 > SQL Editor > New query 에 통째로 붙여 넣고 Run
-- 여러 번 실행해도 안전하다 (이미 있으면 건너뜀).
--
-- 설계 원칙 (personalization-p1.sql 과 같음)
--  * 브라우저는 이 테이블을 직접 읽지 않는다. 항상 우리 서버(/api/section-blocks)를 거친다.
--  * RLS 를 켜고 정책은 만들지 않는다 -> anon / authenticated 키로는 전부 막힌다.
--  * 사용자별 행이 아니라 모든 사용자가 같이 쓰는 목록이다. 쓰기는 서버가 관리자만 허락한다.

create table if not exists public.section_blocks (
  url_key    text not null,                            -- 화면이 쓰는 기사 주소(savedKeyOf)
  section    text not null,                            -- 뺀 섹션 키 (예 : ai, logistics_competitor)
  title      text,                                     -- 관리자 목록 · 제외어 후보(C)용
  blocked_by text,                                     -- 뺀 관리자 이메일
  created_at timestamptz not null default now(),
  primary key (url_key, section)
);
create index if not exists section_blocks_created_idx
  on public.section_blocks (created_at desc);

alter table public.section_blocks enable row level security;
revoke all on public.section_blocks from anon, authenticated;

-- 확인 : rls_on = true 여야 한다
select c.relname as table_name, c.relrowsecurity as rls_on
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'section_blocks';

-- 되돌리기 (이 기능을 아예 걷어낼 때만)
--   drop table public.section_blocks;
