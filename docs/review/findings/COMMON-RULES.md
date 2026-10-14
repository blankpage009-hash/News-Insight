# 리뷰 에이전트 공통 지시 (읽기 전용)

프로젝트 : D:\Projects\NewsInsight — 네이버 뉴스 프록시. 실제 코드는 server.js(6,288줄) · news-insight-naver.html(10,172줄) 두 파일. 브랜치 review/cleanup.
**어떤 파일도 수정·삭제·생성하지 마라** (읽기·검색·node 실행만). 결과는 최종 답변으로만 돌려준다. 한국어, 쉬운 말.
파일은 Read 도구나 Bash(grep/sed)로 읽는다. 시험 서버가 필요하면 포트 3100(가짜 Supabase) 사용 — 띄우는 법은 docs/review/HANDOFF.md 2절. 토큰은 `node docs/review/tools/token.js` 출력, 헤더 `Authorization: Bearer <토큰>`.
먼저 docs/PERFORMANCE.md 4장("작업할 때 조심할 것", 약 420~500줄)과 docs/review/code-review-cleanup.md 2장을 읽어라.

## 보호 목록 — 문제를 '보고'만 하고 고치자는 제안은 하지 마라
- 두 파일이 같은 값을 가져야 하는 쌍 : html 제외어(~4441) ↔ server DOMAINS[*].exclude · html DEFAULT_KEYWORDS.sports ↔ server DIGEST_EXTRA_PARENTS · html SECTION_FILTER_DEFAULTS ↔ server WARM_*
- 캐시 열쇠·구조 : allSectionParts · briefingParts · digestParts · memoPick · followupCache · indexChartCache · RESP_CACHE_MAX
- c-ares 주소 찾기 : server.js safeLookup(~3849) → Agent(~3863) → fetchPageHead agent 옵션. node-fetch 제거/내장 fetch 교체 제안 금지
- 화면이 안 불러도 사람·크론이 부르는 주소 : /healthz · 모델 진단 · /api/scfi/history?diag=1 · docs/ 에 이름 나오는 주소
- Tailwind CDN · 단일 파일 구조 · [추가]/[수정] 표식 주석

## '안 쓰는 코드' 판정
LSP/AST 쓰지 마라. 글자 그대로 검색: `grep -n -w "이름" server.js news-insight-naver.html privacy.html docs/*.md` 에서 선언 외 0건일 때만 죽은 코드. onclick="..." · 템플릿 문자열 · `/api/${base}/…` · registerSubSectionRoute 로 만든 주소 주의. 사용한 검색 명령과 건수를 같이 적어라.

## 발견 사항 형식 (이 조건 못 채우면 버려라. 억지로 채우지 마라, 없으면 "발견 없음")
각 항목: 1) 파일:줄 2) 구체적 실패 상황(이런 입력/상태 → 이런 잘못된 결과) 3) 분류(죽은 코드/버그/보안/동작 변경 필요) 4) 위험도(상/중/하) 5) 로컬 검증 가능 Y/N (Supabase 실서버·구글 로그인 필요하면 N) 6) 한 줄 쉬운 설명.
오탐 주의: 로컬 keywords.json 은 3섹션 축소본 → "저장된 키워드에 없는 섹션" 경고는 정상. 직접 줄을 열어 확인한 것만 보고하라.
끝에 "확인했고 문제 없던 것" 목록과 "평가하지 못한 것"을 적어라. 답변은 1500단어 이내.
