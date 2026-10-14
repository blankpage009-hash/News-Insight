# 단계 1 정적 사전 조사 (Sonnet medium) — 원본 보고 요약 (단계 9 에서 재검증)
- 서버↔화면 주소 : 화면이 부르는데 서버에 없는 주소 = 죽은 분기 1건. 서버에만 있는 주소 = 보호 대상(/healthz, /api/gemini-models, scfi diag)뿐.
  - 죽은 분기 : html:7990~7991 `currentCategory.startsWith('economy_')` → /api/economy/section/… (서버 미등록, economy_* 카테고리 정의도 없음). 하/Y. `grep -n "economy_" news-insight-naver.html` → 1건
- 죽은 함수 : `server.js:1464 itemMatchesAnyTerm` — `grep -n -w "itemMatchesAnyTerm" server.js news-insight-naver.html privacy.html docs/*.md` → 선언 1건뿐. 하/Y
- 죽은 상수 : `html:2753 categoryQueryMap` — `grep -n -w "categoryQueryMap" …` → 선언 1건뿐. 하/Y
- localStorage 옛 열쇠 : 읽기만 하고 안 지우는 곳 없음(모두 정리 경로 있음). 열쇠 23종 표는 원본 보고 참고.
- console.log : html 0건, server 10건 전부 운영 로그. 주석 처리 코드 덩어리 0건. TODO 0건.
- 같은 값 두 파일 복제 6쌍(SAVED_MAX, READ_MAX, AI_MODEL_RE, PRESS_BLOCK_MAX, PRESS_NAME_TTL_OK/FAIL) — 값 일치, 의도된 복제.
- 중복 코드 : union-find `find` 가 server.js:3005 · 3233 에 복사 (하, 합칠지는 사람 결정 = 묶음 C 후보)
- 못 본 것 : 객체 속성 함수, 파라미터 이름 대조, clearVoteCache/clearKeywordCache 가 지우는 열쇠
