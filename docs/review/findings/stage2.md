# 단계 2 서버 보안 (Opus high) — 원본 보고 요약 (단계 9 에서 재검증)
상 0 · 중 2 · 하 5. 로그인 관문·관리자 검사·파일 노출·SSRF 는 3100 에 실제 공격 요청으로 막힘 확인(에이전트 보고).
중-1. 가짜 JWT(미래 exp, 매번 다른 값) 무한 전송 → Supabase /auth/v1/user 호출 폭증, 토큰 캐시 500칸에서 진짜 사용자 밀려남. tokenInflight 상한·횟수 제한 없음 — server.js:204–219, 264–274. 보안(DoS)/중/Y. (Supabase 429 → 전원 503 은 추정, 미확인)
중-2. 의존성 qs (moderate DoS, GHSA-4mjr-xmp4-gh2g / GHSA-x5fp-wj9c-mxmx) — 로그인 전에 닿음. npm audit fix 는 의존성 변경 = 사용자 승인 필요(CLAUDE.md). proxy-addr(critical)는 trust proxy 미사용이라 영향 없음
하-3. 깨진 JSON 요청 → 로그인 없이 400 HTML 에 서버 경로 스택 노출 — server.js:60 (express.json 이 authGate 291 보다 먼저), 오류 처리기 없음. 운영 NODE_ENV 미확인
하-4. cors() 전체 허용, CSP·X-Frame-Options 없음, X-Powered-By 노출 — server.js:59. Bearer 헤더 방식이라 실제 위험 낮음
하-5. 사진 캐시 오염 — server.js:3943–3971 imageForArticle 캐시 열쇠가 url 하나 → 임의 url 에 다른 네이버 기사 사진을 24시간 묶음(실측 확인). ※ 캐시 열쇠 영역이라 보호 목록과 겹치는지 확인 필요
하-6. `/api/scfi/history?diag=1` 일반 허용 사용자도 호출, 캐시 없음 (보호 주소 — 보고만)
하-7. 대기·거절 사용자는 "내 데이터 지우기" 못 씀 — server.js:261, 1354 ↔ privacy.html:40 문구. PERSONALIZATION.md:368 의 의도된 결정 → 문서 불일치, 정책 결정
문제 없음 : authGate(실패 시 503 차단), 관리자 검사 누락 없음, /:file 목록 방식(경로 탈출 10종 404), AI 키 AES-256-GCM·응답에 끝 4자리만, 내 데이터 지우기 빠진 표 없음, SSRF 16+6 가지 감시 서버에 0건 도달
못 본 것 : Supabase 실제 횟수 제한, 로그인 방식 설정, Render NODE_ENV, 비관리자 시험. 서버 전체에 unhandledRejection 처리 없음(범위 밖 비동기 오류가 새면 프로세스 사망 — 단계 4 의 `q` 배열 건과 연결)
