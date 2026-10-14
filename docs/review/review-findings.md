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
