# 단계 8 저장소 정리 (Haiku, 읽기 전용) — 원본 보고 요약
- 시안 폴더 2개 : `Beyond News Redesign/`(4파일 1.31MB), `Beyond News UI 개선-handoff/`(15파일 0.71MB, 안에 news-insight-naver.html 사본 266KB 포함). 앱 코드 참조 0건(주석 3곳에서 "시안" 언급만: html 41·220·737). → 정리 대상 (사용자 결정 : git rm --cached + .gitignore)
- 버전 불일치 : package.json:3 `3.0.0` / html:143 APP_VERSION `v3.2` / html 기본 글자 `v3.1` 3곳(1852, 1877, 1880). package.json 은 앱이 읽지 않음.
- sql/ 대조 : 표 8개 열 이름 모두 일치. 단 `app_settings` 생성 SQL 이 sql/ 에 없음(RLS 만 켬). 실행 순서 b → b2 → p1.
- .gitignore(4줄: node_modules/ .env keywords.json .cache/ .claude/) 에 `.omc/` 없음 (`?? .omc/`, `?? Beyond News Redesign/.omc/`).
- 못 본 것 : 실서버 Supabase 구조, section_blocks 쓰기 row 전체 칸, 시안 내용.
- (미검증 — 단계 9 에서 확인) 위 수치는 에이전트 보고 그대로.
