-- NewsInsight 섹션 오분류 B2 : '섹션 이동' 기록 (분류 알고리즘을 고도화할 때 쓸 자료)
-- 실행 위치 : Supabase 대시보드 > SQL Editor > New query 에 통째로 붙여 넣고 Run
-- 먼저 personalization-b.sql 이 실행돼 있어야 한다. 여러 번 실행해도 안전하다 (이미 있으면 건너뜀).
--
-- 기존 section_blocks 표에 칸만 더한다.
--  * section  = 기사가 잘못 들어 있던 섹션 (기존 칸 그대로)
--  * moved_to = 관리자가 옮기라고 고른 섹션. 비어 있으면 '어디에도 안 맞음'(그냥 뺌).
--  * 나머지   = 나중에 '왜 잘못 분류됐나'를 분석할 때 쓰는 기사 정보
-- 보안 설정(RLS · 접근 막기)은 표 전체에 이미 걸려 있어 바꿀 것이 없다.

alter table public.section_blocks
  add column if not exists moved_to     text,   -- 옮길 섹션 키 (예 : economy, logistics_coupang). 없으면 null
  add column if not exists summary      text,   -- 화면에 보이던 기사 요약
  add column if not exists source       text,   -- 언론사
  add column if not exists published_at text,   -- 기사 게재 시각
  add column if not exists kw           text,   -- 이 기사를 찾아낸 키워드
  add column if not exists cats         text;   -- 서버가 이 기사에 붙인 섹션들 (쉼표로 이어 붙임)

-- 확인 : 아래 6개 칸이 모두 나와야 한다
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'section_blocks'
  and column_name in ('moved_to', 'summary', 'source', 'published_at', 'kw', 'cats')
order by column_name;

-- 되돌리기 (이 기능을 걷어낼 때만)
--   alter table public.section_blocks
--     drop column moved_to, drop column summary, drop column source,
--     drop column published_at, drop column kw, drop column cats;
