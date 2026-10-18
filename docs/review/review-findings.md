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
