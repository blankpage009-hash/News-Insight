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

---

## 3. 남은 작업

### 3-1. 응답 캐시를 재배포 넘어 살리기  ← **다음에 할 일**

**왜** : 재배포 직후 19초가 걸리는 진짜 이유는 프리워밍 경쟁이 아니라
`respCache` 가 텅 비어서 전체를 처음부터 만들어야 하기 때문이다.
프리워밍은 기동 **30초 뒤** 시작하는데, 재배포 직후 접속자는 대개 t=0에 온다
(접속이 있어야 서버가 깨어나므로). 즉 그 시점엔 경쟁 상대가 아예 없다.
`f1d9b94` 의 슬롯 우선권은 **기동 30초~1분 사이 접속자**에게만 효과가 있다.

**어떻게** : 기사 본문 캐시가 이미 같은 일을 하고 있으니 그 패턴을 그대로 쓴다.
- 참고할 기존 코드 : `saveArticleCacheToSupabase()` / `loadArticleCacheFromSupabase()`
- 저장 위치 : `SETTINGS_TABLE` 에 key/value 행 하나 추가 (`ARTICLE_CACHE_ROW_KEY` 방식)
- 부팅 시 복원 → t=0 접속자가 stale 값을 즉시 받고, 갱신은 뒤에서 (`cachedResponse` 가 이미 그렇게 동작)
- 주의 : `respCache` 는 섹션 응답 전체라 용량이 크다(1~3MB 추정).
  `SUPA_MIN_SAVE_GAP`(2시간) 처럼 쓰기 간격을 두고, 담을 키를 골라야 한다
  (briefing / all-sections 정도만 담아도 t=0 접속자는 커버된다)
- 복원한 값의 나이(`ts`)를 그대로 살려야 stale 판정이 맞는다

### 3-2. 언론사 원문 긁기 축소
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
