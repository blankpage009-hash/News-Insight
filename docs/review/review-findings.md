# 리뷰 결과 기록

## 단계 0 — 기준선 (2026-10-14, 브랜치 `review/cleanup`, 기준 main 699f154)

- `node --check server.js` : 통과
- 줄바꿈 (작업 폴더 · HEAD 동일)
  - server.js : CRLF 6,288 / 6,288줄
  - news-insight-naver.html : **CRLF 10,172 / 10,172줄** ← 계획서·CLAUDE.md 의 "html = LF" 와 다름. `core.autocrlf=true` 라 작업 폴더가 CRLF.
- 로컬 서버 응답 (스크래치패드 `baseline/`, 각 2회)
  - `/healthz` : 200, 키 `ok,uptime,warming,cache,image`
  - `/api/all/sections?perSection=30&hours=24&sort=date` : **401**, 키 `error,code` (`login_required`)
  - `/api/briefing?limit=10&hours=24` : **401**, 키 `error,code`
  - 원인 : 로컬 .env 에 로그인 설정이 켜져 있어 `authGate` 가 토큰 없는 요청을 막음. 로컬에서 기사 응답은 로그인 우회 없이는 못 받음.
- 콘솔 (밝은/다크 첫 화면 = 로그인 화면) : 오류 0건, 경고 1종(Tailwind CDN 프로덕션 경고)
- 스크린샷 : 두 테마 모두 확인(로그인 화면)

## 단계 0 보완 (사용자 결정 2026-10-14: 줄바꿈 기준 = 현재 값 유지 / 로그인 우회 제작)

- 줄바꿈 기준 변경 : 완료 조건 4 → server.js CRLF 6,288 / html **CRLF 10,172** 그대로 유지.
- 로컬 `.env` 는 **진짜 Supabase 주소**를 가리킨다 → 시험 서버는 환경변수로 덮어써서 가짜 Supabase 로만 돌린다.
- 시험 도구 (저장소 밖, 스크래치패드) : `fake-supabase.js`(:54321, 로그인 확인 + 빈 표) · `token.js`(가짜 토큰, exp 10시간) · `fetch2.js`
- 시험 서버 실행 :
  `PORT=3100 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_KEY=test SUPABASE_ANON_KEY=test ADMIN_EMAILS=tester@example.test SUPABASE_CACHE_SYNC=off node server.js`
- 로그인 통과 기준선 (`baseline-auth/`, 포트 3100, 각 2회)
  - `/api/all/sections?perSection=30&hours=24&sort=date` : 200, 키 `sections`, 7섹션 · 기사 104건, 1회째 1912ms → 2회째 5ms(캐시)
  - `/api/briefing?limit=10&hours=24` : 200, 키 `items`, 1264ms → 9ms
  - `/api/me` : 200, 키 `email,name,state,isAdmin,pendingCount`
- 단계 11 비교는 이 기준선으로 한다 (기사는 시간 따라 바뀌므로 건수·키 이름·상태 코드 위주).

## 단계 10 — 수정 결과 (2026-10-18, 브랜치 `review/cleanup`)

범위 : 사용자 결정(2026-10-14) "죽은 코드 + 명백한 버그만" → 묶음 A·B 만. 묶음 C · '보고만' · 의심 항목은 손대지 않음. push 안 함.

| 커밋 | 항목 |
|---|---|
| 1425edc 묶음 A | A1~A6 (죽은 함수·상수·변수·CSS 삭제, 디자인 시안 폴더 20개 추적 제외 + .gitignore) |
| deb499f 묶음 B 서버 | F1 · F4 · F5 · F6 · F18 · F20 · F21 · F25 · F26(차단 주소 캐시 안 함) · F32 |
| 0394bcf 묶음 B 화면 | F2(화면 쪽) · F3 · F12 · F13 · F14 · F15 · F22 · F23 · F24 · F50 |

고치지 않은 B 항목 : F33(선택, 미룸) · F2 의 서버 stripHtml 순서(보고만) · F26 의 열쇠 변경(C).
확인 : `node --check server.js` 통과 · 시험 서버(가짜 Supabase)에서 `?q=a&q=b` 400(서버 생존) · `key=constructor` 400 · 깨진 JSON 400 짧은 문구 · `display=-5/2.5` 200 · `/api/indices` 200 · 화면 로드 콘솔 오류 0 · `plainText('<img onerror>')` 실행 안 됨 · `javascript:` 주소 → 네이버 링크로 대체 · 검색 중 두 번째 `runSearch` 가 대기열(true)에 들어가 끝난 뒤 실행됨.
줄바꿈 : server.js · html 모두 현재 값(LF) 유지. package.json 변화 없음. 보호 목록 줄 diff 0.
못 한 것 : fetchHtml 본문 정지 9초 차단과 EUC-KR 실제 기사 해석은 로컬에서 실제 요청으로 시험하지 않음(디코더 단위 확인만) · 단계 11(전체 검증 + diff 리뷰) 남음.

## 단계 11 — 검증 + 최종 diff 리뷰 (2026-10-18, 브랜치 `review/cleanup` 0575fce)

메인 세션이 직접 했다(에이전트 안 씀). 시험 서버 = 가짜 Supabase + 포트 3100, 비교용으로 main 의 server.js 를 포트 3101 에 같이 띄움.

### 완료 조건 점검 (계획서 4장)

| # | 조건 | 결과 |
|---|---|---|
| 3 | `node --check server.js` | 통과 |
| 4 | 줄바꿈 | **두 파일 모두 LF — main · 699f154 · HEAD · 작업 파일 전부 같음** (`git ls-files --eol` = `i/lf w/lf`, node 로 CRLF 0건 확인). 바뀐 것 없음. ※ 단계 0 의 "CRLF 6,288" 은 Git Bash grep 이 CR 을 지우고 세서 생긴 잘못된 측정이었다. CLAUDE.md 의 "server.js CRLF" 도 실제와 다르다 |
| 5 | 요청 3개 상태·모양 | `/healthz` 200 · `/api/all/sections` 200 키 `sections` 7섹션 · `/api/briefing` 200 키 `items` 10건 · `/api/me` 200. 두 번째 요청 3ms 안팎(캐시 적중) |
| 5+ | main 과 같은 시각 비교 | `hours=23` 으로 두 서버에 동시에 요청 → **섹션별 건수 7개 모두 같음, 기사 주소 차이 0건, 응답 키 같음** |
| 6 | 콘솔 오류 | 밝은 테마 0 · 다크 테마 0 (기준선 0) |
| 7 | 보호 목록 줄 | `git diff main -- server.js` 에 걸린 2줄은 hunk 머리말·문맥 줄(`allSectionParts`)뿐, 바뀐 줄 0 |
| 8 | package.json | 변화 없음 |

### 고친 버그 재현 (다시 해 본 결과)

- 서버 : `?q=a&q=b` 400 + 서버 생존 · `index-chart key=constructor`/`range=__proto__` 400 · 깨진 JSON → 400 짧은 문구 (main 은 스택 HTML) · `display=-5/2.5/abc` → 1/2/기본 · `/api/indices` 200
- 쉼표 검색 : `코스피 3,000` → 수정 후 AND 1덩어리(14건) / main 은 `코스피 3` OR `000` 으로 잘림. `롯데,한진` · `삼성전자,1등` 은 둘 다 OR 그대로
- fetchHtml (server.js 원문을 잘라 로컬 가짜 언론사로 시험, `scratchpad/fetchhtml-test.js`) : UTF-8 · EUC-KR(머리말) · EUC-KR(`<meta>`) 모두 한글 정상 · 본문 중간 끊김 → 서버 안 죽고 빈 값 · **본문 멈춤 → 18.0초(9초 × UA 2번) 뒤 포기** (예전엔 무한 대기)
- 화면 : `plainText('<img onerror>')` 실행 0회 · `javascript:` 주소 → 네이버 주소 / 없으면 `#` · 브리핑 제목 10개에 `&quot;`·`<b>` 날것 0개 · 검색 중 두 번째 검색 → 대기열 → 끝난 뒤 1번 더(총 2회) · 관련 기사 A→B 빠르게 열기 → B 만 표시 · 같은 섹션 새로고침 2번 동시 → 로딩 표시 남지 않음 · 지수 차트 정상

### diff 리뷰에서 새로 찾은 것

| # | 위치 | 내용 | 분류 | 위험도 | 상태 |
|---|---|---|---|---|---|
| R1 | server.js:3973 (F26) | 원문 주소가 막히면(8080 같은 포트 등) 바로 `''` 를 돌려줘서, **예전에 되던 '네이버 주소로 사진 다시 찾기'가 빠졌다.** 시험 : 원문 `:8080` + 네이버 주소 3건 → main 3/3 사진 · 수정 후 0/3. 오늘 기사 104건 중 해당 0건이라 드묾. '고장 → 정상만' 규칙 위반 | 버그(회귀) | 하 | **고침** (사용자 승인 2026-10-18) : 막힌 경우 네이버 주소가 맞으면 `imageForArticle(naverUrl, '')` 로 넘김(캐시·대기열 그대로 씀) |
| R2 | html:9704 openInsight catch | 다른 세 팝업과 달리 실패(catch) 쪽에 낡은 응답 검사가 없다. A 의 Insight 를 연 뒤 B 를 열고, A 요청이 네트워크 오류로 늦게 실패하면 B 화면에 A 의 오류 문구가 덮인다 | 버그 | 하 | **고침** (사용자 승인 2026-10-18) : catch 에 `currentInsightId !== id` 검사 1줄 |
| R3 | server.js:2849 주석 | `clampLimit` 주석은 "음수 → 기본값" 이지만 실제로는 1 이 된다. 동작은 문제없음 | 참고 | — | — |
| R4 | server.js:1483 | `2024,2025` 처럼 숫자끼리 붙은 쉼표는 이제 OR 로 안 나뉜다 (천 단위 쉼표 처리의 부작용) | 참고 | — | — |
| R5 | html:7778 runSearch | 대기열에 넣을 때 '지금 도는 검색'의 약속(promise)을 돌려준다. `await runSearch()` 하는 곳은 당겨서 새로고침(5017) 하나뿐이고 고리 표시 시간에만 쓴다 → 고리가 대기열 검색보다 먼저 사라질 수 있음(눈에 보이는 영향만, 결과는 정상) | 참고 | — | — |

### 추가 확인 (지운 코드 · 남은 재현)

- 지운 이름 글자 검색 (`grep -c -w 이름 server.js news-insight-naver.html privacy.html`, HEAD) : `itemMatchesAnyTerm` · `categoryQueryMap` · `expandedEconomy` · `panel-more` · `loading-ring` · `is-card` 모두 0. `pv-verdict` 4건은 전부 `pv-verdict-list`(다른 클래스, html:910~). `bc-save is-${kind}` 의 kind 는 호출 2곳 모두 `'row'` 라 `is-card` 는 안 생긴다
- `economy_` : 서버에 `registerSubSectionRoute('economy', …)` 없음(logistics · stock · sports 만) → 지운 분기는 원래 못 가는 길. 화면에서 경제 · 물류 · 증시 · 스포츠와 하위(롯데글로벌로지스 · 국내 · 포항스틸러스) 눌러 봄 → 모두 정상, 콘솔 오류 0 (롯데 24시간 0건은 실제로 기사 없음, 7일 5건)
- 디자인 시안 폴더 2개 : PC 에 그대로 있음(`Beyond News Redesign` · `Beyond News UI 개선-handoff`)
- `lead`(요약) 는 서버가 `stripHtml` 한 순수 글자(server.js:2336) → `esc` 가 맞다. 굵게 표시 같은 의도된 태그 없음
- 실행해 보지 않고 코드만 읽은 수정 : warmCache 키워드 대체 · SCFI 실패 뒤 다시 열기 · SCFI 날짜 `esc` · 1일 지수 차트 5분 뒤 다시 받기 · 주요 내용/Insight/이어보기 팝업의 낡은 응답 버리기(관련 기사만 실행해 봄)

정리 : 테스트 서버 · 임시 파일(`server-main.tmp.js`) 정리함. `.cache/article-text.json` 정상(386건). push 안 함.

### R1 · R2 수정 뒤 재시험 (2026-10-18)

- `node --check server.js` 통과 · 줄바꿈 두 파일 모두 LF 그대로(CRLF 0) · package.json 변화 없음
- R1 : 원문 `:8080` + 네이버 주소 3건 → 사진 **3/3** (고치기 전 0/3, main 3/3) · 네이버 주소가 없거나 네이버가 아닌 주소(`127.0.0.1` · `localhost`) → 빈 값 3건 · 사진 캐시 칸 0 → 3 (막힌 원문 주소는 안 들어가고 네이버 주소 열쇠만) · 정상 원문 → 사진 1/1 · 서버 생존
- R2 : A 의 Insight 를 연 뒤 B 를 열고 A 요청을 0.8초 뒤 실패시킴 → B 화면은 '뽑는 중' 그대로, 뒤이어 B 응답만 표시. 기사 하나만 열고 실패시키면 '인사이트를 불러오지 못했습니다.' 정상 표시
- 화면 다시 불러오기 뒤 새 콘솔 오류 0
