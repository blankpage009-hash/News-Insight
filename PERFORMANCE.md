# 로딩 속도 개선 — 진행 상황과 남은 작업

새 대화창에서 이어서 작업할 때 이 문서를 먼저 읽으면 됩니다.
마지막 갱신: 2026-07-23

---

## 0. 프로젝트 기본

- `server.js` — Express 프록시, 단일 파일 약 2,500줄, **줄바꿈 CRLF**
- `news-insight-naver.html` — 단일 페이지 약 3,060줄, **줄바꿈 LF**
- 배포 : https://news-insight.onrender.com (Render). `origin/main` 에 push하면 자동 배포
- 데이터 : 네이버 검색 API(NCP API Gateway), 네이버 증권, FRED, 한국은행 ECOS, Supabase(키워드 설정 + 캐시 사본)

---

## 1. 현재 성능 (라이브 실측)

| 항목 | 개선 전 | 현재 |
|---|---|---|
| 첫 화면 기사 표시 | 약 7,400ms | 340ms |
| `/api/briefing` | 5,730ms | 146ms |
| `/api/all/sections` | 3,630ms | 254ms |
| `/api/indices` | 650ms | 133ms |
| `/api/market-extra` | 8,200ms | 1ms 내외 (캐시 히트) |
| 재배포 직후 첫 요청 (`all/sections`) | 19초대 | 로컬 재현 기준 1,366ms → 28ms |

---

## 2. 지금까지 한 일 (모두 배포 완료)

### 응답 캐시 (`85d395e`)
- 핵심 함수 : `cachedResponse()` / `runProducer()` / `respCache` / `respInflight`
- 동작 : fresh 이내 즉시 반환 → stale 이내는 일단 반환하고 뒤에서 갱신 → 초과 시 대기
- 같은 키에 동시 요청이 와도 계산은 1회만 (single-flight)
- TTL : `TTL_SECTION` {2분, 60분} / `TTL_BREAKING` {30초, 5분} / `TTL_INDICES` {25초, 5분} / `TTL_MARKET_EXTRA` {1분, 30분}
- 캐시 키는 `kwSig()` 로 정규화 — 프런트가 보낸 kw 문자열이 아니라
  `resolveSectionKw()` 로 확정된 '실제 검색에 쓰일 값'을 해시한다

### 프리워밍 개편 (`85d395e`)
- 기사 본문이 아니라 **완성된 응답**을 데운다 (`warmJobs()`)
- 화면이 보내는 조건과 정확히 같아야 캐시 키가 맞음
  (`WARM_HOURS=24`, `WARM_SORT=sim`, `WARM_PER_SECTION=30`, `WARM_BRIEFING_LIMIT=10`)
- 소요시간 57초 → 13초

### 프런트 초기 로딩 병렬화 (`85d395e`)
- 기존엔 `await loadKeywords()` 가 기사 요청을 막고 있었다
- `seedKeywordsFromCache()` 로 localStorage 값으로 즉시 시작 →
  `syncKeywordsInBackground()` 가 서버 값을 따로 확인, 다르면 다시 렌더 + `runSearch()`
- `runSearch()` 는 래퍼, 실제 본문은 `runSearchInner()`

### 네이버 동시 호출 제한 (`85d395e`)
- `NAVER_MAX_CONCURRENT = 6`. 27개를 한꺼번에 쏴서 429 → 재시도 → 또 429 되던 악순환 제거

### 첫 화면 로딩 (`7aa13aa`)
- `window.onload = init` → `DOMContentLoaded` 시점으로. onload는 이미지까지 다 받은 뒤라 674ms 지연
- `rss-icon.png` 333x345(125KB) → 93x96(14KB). 화면 표시 크기는 최대 32px

### market-extra (`9a2e1bc`) ← 1순위였음
- 응답 캐시 적용 (`MARKET_EXTRA_KEY`, `buildMarketExtra()`)
- FRED 타임아웃 8초 → 2.5초 (`FRED_TIMEOUT_MS`)
- **FRED 차단 감지** : 한 번 실패하면 30분간 호출 안 함 (`fredBlockedUntil`, `FRED_COOLDOWN_MS`).
  성공하면 자동 복구
- 프리워밍도 market-extra 를 데움 (네이버 API를 안 쓰므로 기사 프리워밍과 동시 실행)

### 사용자 요청 우선권 (`f1d9b94`) ← 2순위였음
- 네이버 슬롯 대기열을 `naverQueueUser` / `naverQueueWarm` 둘로 분리
- 규칙 : **"사용자가 기다리고 있으면 프리워밍은 새 슬롯을 잡지 않는다"** (`naverSlotAcquire`, `naverSlotPump`)
  - 기다리는 사용자가 없으면 프리워밍이 6슬롯을 다 쓴다 → 프리워밍이 느려지지 않는다
  - 6슬롯 중 몇 개를 고정 예약하는 방식은 이 이유로 채택하지 않았다
- 프리워밍 여부는 `AsyncLocalStorage`(`warmFlag`, `isWarming()`)로 전달.
  호출 단계마다 인자를 추가하지 않아도 하위 네이버 호출이 자동 구분된다
- `WARM_SKIP_IF_YOUNGER`(5분) : 최근 갱신된 칸은 프리워밍이 건너뛴다
- 실측 : 사용자 대기 987ms → 357ms, 프리워밍 전체 완료는 1047 → 1022ms (변화 없음)

### 응답 캐시를 재배포 너머로 잇기 (3-1 이었음)
- 재배포 직후 19초의 진짜 원인은 프리워밍 경쟁이 아니라 `respCache` 가 텅 비는 것이었다.
  프리워밍은 기동 30초 뒤에 시작하는데 첫 접속자는 t=0에 온다(접속이 있어야 서버가 깨어나므로).
- 기사 본문 캐시와 같은 방식으로 **완성된 응답**도 Supabase(`RESP_CACHE_ROW_KEY = 'resp_cache'`)에
  사본을 남기고, 기동할 때 되살린다. 핵심 함수 :
  `saveRespCacheToSupabase()` / `loadRespCacheFromSupabase()` / `respRestoreReady`
- 담는 대상 : 프리워밍이 데우는 칸만 (지표 + 브리핑 + 전체/물류/증시/스포츠 섹션).
  `RESP_SUPA_MAX_BYTES`(800KB) 예산 안에서 **앞에 있는 것부터** 담는다 → 중요한 칸이 먼저 산다
- 저장 시점 : 프리워밍이 끝날 때(`RESP_SUPA_MIN_SAVE_GAP` 25분 간격) + 종료 신호를 받을 때(간격 무시)
- **저장 간격은 반드시 `TTL_SECTION.stale`(60분)보다 짧아야 한다.**
  사본이 stale 보다 낡으면 되살려도 '너무 낡음' 판정이라 아무 소용이 없다
- 복원할 때 `respCacheSet()` 을 쓰면 안 된다. ts 를 '지금'으로 새로 찍어서
  낡은 값이 갓 만든 값처럼 보이게 되고 stale 판정이 어긋난다. `respCache.set()` 으로 직접 넣는다
- 첫 손님은 `cachedResponse` 안에서 복원이 끝날 때까지 잠깐 기다린다(`RESP_RESTORE_MAX_WAIT` 3초 상한).
  안 기다리면 캐시가 빈 것으로 보고 전부 새로 만들어 버려서 복원이 헛일이 된다
- 실측(로컬, 가짜 Supabase로 재배포 재현 · 아래 '조심할 것' 참고) :
  재배포 직후 첫 요청 `all/sections` 1,366ms → **28ms**, `briefing` 152ms → **3ms**.
  로컬은 네이버 API 지연이 짧아 '개선 전' 값이 작게 나온다. Render 에서는 차이가 더 크다

---

## 3. 남은 작업

### 3-2. 언론사 원문 긁기 축소  ← **다음에 할 일**
`filterByCore`(`VERIFY_LIMIT` 20) + `refineByDomain`(`DOMAIN_VERIFY_LIMIT` 12) = 섹션당 최대 32건.
`fetchHtml` 이 UA 2개로 재시도, 타임아웃 9초, `VERIFY_CONCURRENCY` 20.
캐시 미스 시 여전히 느리다. 값을 줄이거나, 응답을 먼저 보내고 검증은 백그라운드로.

### 3-3. Render 리전을 싱가포르로 이전 (코드 변경 없음, 설정만)
현재 오리진이 한국까지 왕복 150~250ms. 네이버 API 호출마다 이 비용이 붙는다.

### 3-4. `searchByTerms` 의 per 값 축소
`per = max(30, min(100, display*4))` 라서 매번 100건씩 받아 대부분 버린다.

### 3-5. 키워드를 묶어서 검색 (A OR B)
현재 '키워드 1개 = 네이버 API 호출 1회'. 전체 화면 27회, 브리핑 21회.
정확도에 영향이 있어 신중히.

---

## 4. 작업할 때 조심할 것 (실제로 겪은 것들)

- **프리워밍 캐시 키 일치가 깨지기 쉽다.** 프런트는 `DEFAULT_KEYWORDS` 로 빠진 섹션을
  채워 보내지만 서버 프리워밍은 저장된 설정만 본다. 어긋나면 조용히 헛돈다
  (느려지는 게 아니라 안 빨라진다). Render 로그에
  `[프리워밍] 저장된 키워드에 없는 섹션` 이 뜨면 그 상태. 설정 화면에서 한 번 저장하면 해결.
  현재 프로덕션은 Supabase에 전 섹션이 있어 정상.
- **로컬 `keywords.json` 은 3섹션 축소본**이라 로컬에서는 위 경고가 정상적으로 뜬다.
  또 프리워밍이 슬롯을 오래 잡지 않아서 **슬롯 경쟁 관련 A/B 측정이 로컬에선 안 된다.**
  그때는 `server.js` 에서 슬롯 관리 코드 블록만 떼어내 부하를 재현하는 방식이 잘 통했다
  (`const NAVER_MAX_CONCURRENT` ~ `naverSearchRaw` 까지 잘라서 `new Function` 으로 실행).
- 로컬에 `SUPABASE_*` 환경변수 없음 → 파일 폴백으로 동작.
  **Supabase 관련 기능은 로컬에서 아예 꺼진 채로 돈다.** 확인하려면 가짜 Supabase를 띄우는 게 잘 통했다 :
  `app_settings` 의 GET(`?key=eq.X&select=value` → `[{value}]`) / POST(upsert) 만 흉내내는
  Node 서버 40줄이면 충분하고, `SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_KEY=test` 로 실행한다.
  - 재배포 재현 = 앱 프로세스 kill + `.cache/article-text.json` 삭제 + 다시 실행.
    이때 **가짜 Supabase도 같이 재시작해야 한다** (메모리에 값을 들고 있어서 store 파일만 고치면 반영이 안 된다)
  - '개선 전' 상태는 저장된 `resp_cache` 행을 지우고 재현한다
- 측정용 요청은 파라미터 이름을 정확히 맞춰야 한다. 하나라도 다르면 프리워밍과 **다른 칸**을 재게 된다.
  `/api/all/sections` 는 `limit` 이 아니라 **`perSection`** 이다
  (`?perSection=30&hours=24&sort=sim`, 브리핑은 `?limit=10&hours=24`).
- 로컬 포트 3000이 이미 쓰이는 경우가 있어 `.claude/launch.json` 에 `"autoPort": true` 를 넣어 뒀다
  (`.claude/` 는 `.gitignore` 대상이라 커밋되지 않음).
- **줄바꿈** : `server.js` CRLF, `news-insight-naver.html` LF. 편집 후 확인할 것.
- 이미지 처리 도구 없음(sharp / ImageMagick 미설치).
  PowerShell `System.Drawing` 으로 축소 + Node 내장 `zlib` 로 무손실 재압축으로 처리했다.
- 화면 기본값 : `hours=24`, `sort=sim`, `perSection=30`, 브리핑 `limit=10`.
  브리핑 외 카테고리로 이동하면 count가 5로 바뀐다(`applyBriefingCountDefault`).
- FRED가 막혀 있는 동안 미국 기준금리는 코드에 박아둔 폴백값
  `FALLBACK_US_BASE_RATE`(3.50~3.75%, `live:false`)로 표시된다.
  FOMC가 금리를 바꾸면 자동으로 안 바뀌므로, 나중에 다른 경로(예: ECOS의 미국 금리 통계)를 검토.

---

## 5. 캐시 동작 특성 (알아둘 것)

기사 데이터가 항상 실시간은 아니다. 보통 30분 이내(프리워밍 주기), 최대 60분.
속보는 30초/5분으로 짧게 잡아 '최근 1시간 기사' 화면은 최신을 유지한다.
더 짧게 하려면 `server.js` 의 `TTL_SECTION` 값만 조정하면 된다.
