# 단계 8 재점검 (Haiku 단계를 직접 확인, 2026-10-18) — 읽기 전용

## A. 디자인 시안 폴더 (확정, 위험 하 / Y)
- `Beyond News Redesign/` 5파일, `Beyond News UI 개선-handoff/` 15파일 = 추적 파일 20개(`git ls-files | grep -c "Beyond News"`). 디스크 크기 약 1.5MB + 0.7MB.
- 앱 코드 참조 0건 : `grep -n "Beyond News Redesign\|UI 개선-handoff" server.js news-insight-naver.html package.json` → 0건. 문서(REDESIGN*.md, PERSONALIZATION.md)에서만 이름이 나옴 → 저장소에서 빼도 문서에 "원본은 PC에만 있다"는 정도의 영향.
- 사용자 결정(2026-10-14) : `git rm --cached` + `.gitignore` 추가(PC 파일 유지). 단계 10 묶음 A 후보.
- 주의 : 폴더 안 `news-insight-naver.html` 사본(266KB)이 있어 html 글자 검색 시 오탐 가능 — 앱이 쓰는 파일이 아님.

## B. 버전 표기 불일치 (확정, 하 / Y)
- package.json:3 `3.0.0` ↔ html:143 `APP_VERSION='v3.2'`. html 기본 글자 `v3.1` 3곳(1833, 1858, 1861)은 JS 가 `v3.2` 로 덮어씀(145) → 화면엔 v3.2. package.json 버전은 앱이 읽지 않음. 동작 영향 없음, 맞출지는 사용자 판단(동작 변경 필요 아님, 문서 성격).

## C. sql/ 대조
- sql 3개의 표 7개 생성(allowed_users · article_votes · read_marks · saved_articles · section_blocks · user_ai_keys · user_settings) + `app_settings` 는 RLS 만 켬(p1:89). server.js 는 `app_settings`(121)를 쓰는데 **생성 SQL 이 저장소에 없음** → 새 Supabase 에 옮길 때 빠짐(하 / N: 실서버 구조 필요). 실행 순서 b → b2 → p1.
- 열 이름 대조는 이전(Haiku) 결과 "모두 일치"를 그대로 믿음 — 이번엔 재검증 안 함.

## D. .gitignore (확정, 하)
- 4줄 외에 `.omc/` 가 이미 있음(현재 파일 기준 — 이전 보고의 `?? .omc/` 는 해소). 시안 폴더만 추가하면 됨.

## E. 평가하지 못한 것
실서버 Supabase 구조 · sql 열 단위 재대조 · 시안 내용 · 문서 속 시안 경로 안내 문구 수정 필요 여부.
