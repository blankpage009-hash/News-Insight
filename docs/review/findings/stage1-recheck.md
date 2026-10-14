# 단계 1 재점검 (Opus · 2026-10-14) — 이전 Sonnet 결과 확인 + 놓친 것

검색 도구 : 스크래치패드 `scan.js`(한 번만 나오는 이름 · 몸통 밖에서 안 불리는 함수 · 쓰기만 하는 변수) · `handlers.js`(onclick 이 부르는 함수 존재 여부) · `ids.js`(getElementById 대상 존재 여부) · `params.js`(라우트별 받는 값)
대상 : server.js(이름 844개) · news-insight-naver.html(이름 1052개) · privacy.html · docs/*.md

## 이전 결과 확인
| 이전 항목 | 재확인 |
|---|---|
| server.js:1464 `itemMatchesAnyTerm` 죽은 함수 | 확정 — 전체 1건(선언뿐) |
| html:2753 `categoryQueryMap` 죽은 상수 | 확정 — 전체 1건 |
| html:7990 `startsWith('economy_')` 죽은 분기 | 확정 — `economy_*` 키 없음, 서버도 `/api/economy/section` 미등록 |
| 서버에만 있는 주소 = 보호 대상뿐 | 확정 — `/api/gemini-models`, `/api/scfi/history?diag`, `/healthz` |
| console.log html 0 / server 10, 주석 코드 0, TODO 0 | 확정 (server.js:4868 주석은 사용 예시) |
| localStorage 옛 열쇠 정리 | 확정 — v1 저장·읽음은 3513-3514 에서 지움, 옛 키워드는 4590 |

## 새로 찾은 것 (이전에 놓침)
1. **html:2782 `expandedEconomy` — 쓰기만 하고 읽지 않는 변수** (죽은 코드 · 하 · Y)
   - `grep -n -w expandedEconomy news-insight-naver.html` → 4건(2782 선언, 6578·6679 대입, 0 읽기). 6418-6420 펼침 표에 economy 없음.
   - bc8f625 에서 경제 하위 섹션을 지울 때 남은 조각. 6578 · 6679 줄도 함께 지울 대상.
2. **모바일 드로어 잔재 — 여는 길이 없어 실행될 수 없는 코드** (죽은 코드 · 하 · Y)
   - `setNav(true)` 를 부르는 곳 0건 (`grep -n "setNav(" ` → 정의 4869 · closeNav 4875 뿐). 여는 `toggleNav` 는 7952e62 에서 지움(REDESIGN-v3.md:505,511 사용자 결정).
   - 그래서 `body.nav-open` 은 절대 붙지 않는다 → 4747(Esc 닫기) · 4969 · 6643-6644 의 `nav-open` 검사, 4872 `nav-toggle-btn`(그 id 의 요소 자체가 없음, e31d81e 에서 삭제), 2000 `#nav-scrim`, 2036 닫기 버튼은 항상 헛돈다.
   - `#sidebar` DOM 자체는 숨은 필터 저장소라 **남겨야 함**(html:465, 1973 주석). 지울 수 있는 건 nav-open 관련 줄만.
   - 오류는 없다(`if (btn)` 으로 막혀 있음). 지우려면 CSS·마크업·JS 세 곳을 건드림 → 묶음 C 후보로 보고만 해도 됨.
3. **html:8611-8620 `fetchOneSection` 의 `/api/${base}/section/` 분기 — 닿지 않는 분기** (죽은 코드 · 하 · Y)
   - 섹션 상자(`sectionState`)는 '전체' 화면에서만 채워진다(`grep -n "sectionState = "` → 2789 빈 배열 · 7894 초기화 · 7964 전체 화면, `push/splice/unshift/[ ]` 0건). 7894 초기화는 화면을 불러올 때마다 맨 앞에서 돈다. 그래서 `currentCategory !== 'all'` 인 else 분기와 "물류/증시 화면 : 하위 섹션" 주석(8609)은 옛 구조의 흔적.
   - 만약 이 분기가 돈다면 '전체' 상자 열쇠(예: `breaking`)로 `/api/breaking/section/breaking` 을 불러 404 가 난다 — 즉 살아 있으면 오히려 고장 나는 코드.

## 두 파일 같은 값 쌍 (보호 목록 · 직접 값 비교)
| 쌍 | 결과 |
|---|---|
| html `LOGI_EXCLUDE`(4441) ↔ server `DOMAINS.logistics.exclude`(~1570) | 14개 일치 (`pairs.js`) |
| html `STOCK_EXCLUDE` ↔ server `DOMAINS.stock.exclude` | 3개 일치 |
| html `SPORTS_EXCLUDE` ↔ server sports | 둘 다 빈 목록 |
| html `DEFAULT_KEYWORDS.sports`(4482 `['스포츠','축구','야구']`) ↔ server `DIGEST_EXTRA_PARENTS.sports.terms`(4218) | 일치 |
| html `SECTION_FILTER_DEFAULTS`(6590 hours '24' · sort 'date') ↔ server `WARM_HOURS`/`WARM_SORT`(6141-6142) | 일치 · `WARM_PER_SECTION 30` ↔ 화면 perSection '30'(6748) 일치 |
| SAVED_MAX 300 · READ_MAX 1000 · AI_MODEL_RE · PRESS_BLOCK_MAX 300 · PRESS_NAME_TTL_OK 7일 · _FAIL 6시간 | 모두 일치 |

## 확인했고 문제 없던 것
- 화면 버튼 `onclick` 등이 부르는 함수 97개 — 모두 정의돼 있음 (없는 함수 0)
- `getElementById` · `querySelector('#…')` 대상 id — `nav-toggle-btn` 1개 빼고 모두 존재
- 화면이 보내는 값 이름 ↔ 서버가 읽는 값 이름 : news · briefing · section · digest · topic · keyword-rank · related · deep-brief · insight · index-chart · breaking · ai-models · admin/users · votes · section-blocks · sync · ai-key · me/data(확인 단어 '삭제' 일치) · settings/keywords — 전부 일치
- '전체' 화면은 서버에 언론사 거르기 값을 안 보내고(3420 서버도 안 읽음) 화면에서 거른다(7025) — 일관됨
- 쓰기만 하는 변수 후보 `pickValueSeq`(server 2681) · `nextId`(html 2791) 는 `++` 값을 실제로 씀 → 오탐
- 한 번만 나오는 `lockScrollWhileModalOpen`(html 9199) 은 즉시 실행 함수 → 정상
- package.json 의존성 4개 모두 require 됨 · 서버가 읽는 환경변수 12개 = .env 이름 11개 + GEMINI_MODEL(선택값) · .env/keywords.json 은 git 에 안 올라감

## 참고 (고칠 필요 없음)
- 옛 열쇠 `news-insight-sidebar-collapsed` 는 이제 안 읽지만 지우지도 않음(html:4877 주석). 사용자 브라우저에 몇 바이트 남는 정도.

- 이전 보고의 "clearVoteCache/clearKeywordCache 가 지우는 열쇠 미확인" → 이번에 확인 : 로그아웃(`clearPersonalCache` 3298) 이 개인 열쇠 14종을 지우고, 표·추천(3594) · 키워드(4595) 는 각 함수가 지움. 남는 건 언론사 이름 사본(공용 정보) · 옛 v1 목록(일부러 남김)뿐.

## 평가하지 못한 것
- **객체 안 함수·칸 이름**(예: `PREF_SYNC` 의 `local`/`apply`, 서버가 보내지 않는 설정 칸) — 이름이 흔해서 글자 검색으로는 '안 쓰임'을 판단할 수 없다. 이번에도 못 봤다(이전 보고와 같음).
- CSS 클래스 사용 여부(단계 7) · 실행 중 문자열로 만드는 함수 이름(`window[name]`) — 검색 결과 그런 호출은 찾지 못함
