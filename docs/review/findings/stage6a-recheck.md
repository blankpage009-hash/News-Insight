# 단계 6a 재점검 — 화면 출력 이스케이프 XSS (Opus · high · 2026-10-18)

범위 : html 전체 JS 의 innerHTML · insertAdjacentHTML · 템플릿 문자열 (82줄 전수 + esc 없는 `${…}` 대조).
**html 줄 번호는 main 699f154 사본 기준.** SCFI 는 그 뒤 티커바로 옮겨져 **"현재 :줄" 은 지금 작업 파일 기준**이다. server.js 는 바뀌지 않았다.
방법 : server.js `stripHtml`, html `looksLikeArticleUrl` · `articleLink` · `scfiRangePoints` 의 실제 본문을 `node -e` 로 실행. 서버·브라우저·네이버·Supabase 는 부르지 않았다.
배경 : CSP 0건. 로그인 세션이 localStorage 에 있음(5399–5401 `persistSession: true`) → XSS 한 번이면 그 사용자 토큰으로 API 호출 가능, 관리자면 허용 사용자 목록·섹션 기록까지 바뀔 수 있음.
종합 위험도 : **상 2 · 중 1 · 하 3** — 전체 HIGH

## 새로 찾은 항목

| # | 위치 | 예시 입력 → 실행 결과 | 분류 / 위험 / 로컬검증 | 수정안 |
|---|---|---|---|---|
| R1 (= 중-1 수정) | server.js:1418 stripHtml(숫자 참조 `&#60;` 는 안 풂) → html:4081 · 4085 `plainText(title/summary)` → server.js:527–529(길이만 자르고 저장) → html:3918–3923 movedRawFor → 8353 · 8354 · 8388 · 8390 | 네이버 제목 `&amp;#60;img src=x onerror=alert(1)&amp;#62; 물류 소식` → stripHtml 뒤 `&#60;img …&#62; 물류 소식`(node 실측). 카드에선 글자로만 보여 무해해 보임. **관리자가 '섹션 이동'을 누르면** plainText 의 textContent 가 `&#60;` 를 진짜 `<` 로 풀어 `<img src=x onerror=alert(1)> 물류 소식` 이 서버에 저장 → 옮긴 섹션을 여는 **모든 사용자** 화면에서 실행. 요약(`${lead}`)도 같은 길 | 보안 · 중 · N (1단계 node 확인, textContent 풀기는 HTML 표준 동작이나 브라우저 실행은 못 함) | 화면 카드에서 `${esc(item.title)}` · `${esc(lead)}` (상-1 과 같은 수정). plainText 를 DOMParser 로 바꿔도 `&#60;`→`<` 풀기는 그대로라 **막는 곳은 화면에 넣는 자리여야 함** |

## 이전 항목 재확인

| 원본 | 판정 | 근거 · node 실측 |
|---|---|---|
| 상-1 제목·요약 esc 없음 | **확정 (보강)** · 상 · Y | 8353 · 8354 · 8388 · 8390 · 9809 · 9811 · 9563 직접 확인. `stripHtml('&lt;img src=x onerror=alert(1)&gt;')` → `<img src=x onerror=alert(1)>`, `'&amp;lt;svg onload=alert(1)&amp;gt;'` → `<svg onload=alert(1)>` — `&amp;` 를 먼저 풀고 `&lt;` 를 나중에 풀어서 **한 번 감싸든 두 번 감싸든** 진짜 `<` 가 됨. 평범한 `&lt;CES 2026&gt; 개막` 은 `<CES…>` 가 태그로 사라짐(`<신간>` 처럼 `<` 뒤가 한글이면 정상 표시). 공격자가 고를 수 있는 입력 = **언론사가 쓴 제목·요약**. 기사 본문 추출(server.js:1925–2033)은 거르기·AI 입력에만 쓰여 화면 직행 길 없음. 수정안 : 화면 esc · brief-title 은 textContent. 서버 stripHtml 순서 변경은 캐시 내용이 바뀌므로 보고만 |
| 상-2 plainText detached div | **확정** · 상 · Y | 9920–9924, 호출 2979 · 3657 · 4081 · 4085 · 9750 · 9822 · 9873 · 9932. `document.createElement` 로 만든 div 는 현재 문서 소속이라 img src 가 붙는 순간 화면에 없어도 불러오기 시작 → 실패 시 onerror 실행(원 단계에서 브라우저 재현, 이번엔 미실행). 2979 는 저장 패널 그릴 때마다. 수정안 : DOMParser(그림을 안 불러옴) |
| 중-1 섹션 이동 전파 | **수정 → R1** | "상-1 이 먼저 터져야 함"은 틀림 — 숫자 참조로 감싸면 단독 성립. 서버(505–550)는 길이만 자르고 GET 은 모든 허용 사용자에게 돌려줌(488–498) |
| 하-1 javascript: 주소 | **확정 (보강)** · 하 · Y | `looksLikeArticleUrl('javascript:alert(1)//12345')` → true, articleLink → `<a href="javascript:alert(1)//12345" target="_blank">`. 보강 : 저장 패널 링크(2981)는 target=_blank 없이 3010 preventDefault 가 막음 · movedRawFor(3922)는 `naverUrl=''` 라 articleLink 가 검사를 아예 건너뜀. server.js:913 cleanSavedArticle 도 주소 종류 검사 없음 |
| 하-2 renderError | **확정 (문구 수정)** · 하 · Y | 8097–8101. 메시지는 고정 문구만이 아니라 서버 응답 `error` 필드(apiGet 6690–6696). 지금은 뉴스 경로 서버 오류문이 모두 고정이라 사용자 입력이 안 섞임 — 구조상 위험 |
| 하-3 SCFI 날짜 | **수정** · 하 · Y | 옛 패널(사본 7163 · 7285)은 티커로 옮겨짐, 티커 칸(현재 :7106–7118)은 숫자·상수만이라 안전. 남은 곳 **현재 :7324** `${first.date} ~ ${last.date}` · **:7386** tip `${p.date}`. 날짜 출처는 SSE `currentDate`/`lastDate` 하나, 검사 없음(server.js:5847–5848 → 5996–5997 → 6019–6026). KCLA 정규식(5984)·내장 과거값(5963)은 형식 고정이라 안전. node 실측 : SSE 날짜가 `2026-10-17<img src=x onerror=alert(1)>` 면 :7324 → `2026-07-24 ~ 2026-10-17<img …> · 2주`. 외부 사이트가 응답을 바꿔야 해서 하. 수정안 : 화면 `esc(p.date)` 또는 서버 `/^\d{4}-\d{2}-\d{2}$/` 검사(SCFI 는 보호 목록 아님). 축 라벨 :7309 는 미실측 |

## 안전 확인 (직접 줄을 연 것)

| 위치 | 판정 |
|---|---|
| 기사 사진 server.js:3913–3926 · html 8300–8311 | 안전 — 서버가 http/https 만 남기고 화면은 `img.src` 속성 |
| 언론사 이름 server.js:4072–4091 · html 6866–6872 | 안전 — 서버가 `<>{}` 든 이름 거부, 화면 esc · textContent |
| 기사 본문 추출 server.js:1925–2033 | 안전 — 거르기·AI 입력에만 씀 |
| AI 응답 briefHtml 9521–9549 · insight 9660–9730 · aiResultNote 9456–9462 | 안전 — 모든 값 esc (제목에 심은 글자가 AI 를 거쳐 와도 esc) |
| 로그인 화면 5466–5485 | 안전 — email · error esc |
| 관리자 사용자 목록 5627–5645 | 안전 — 신청자 구글 이름(server.js:323)도 esc(hint), onclick 은 esc(JSON.stringify) |
| 관리자 섹션 기록 목록 4152–4160 | 안전 — esc(title) · esc(JSON.stringify) |
| 싫어요·이동 메뉴 4022–4045 | 안전 — 고정 선택지 + esc, 자유 입력 '사유' 칸 없음 |
| 키워드 칩 6123–6131 · 태그 8236 / 8120 | 안전 — 공용 키워드 포함 esc(w) · esc(catLabelOf) |
| 키워드 랭킹 8854 · 8996 | 안전 — esc(word), 클릭은 data 속성 |
| 모델 목록 9398–9412 | 안전 — esc |
| 검색어 표시 7091→7104 · status-line | 안전 — textContent |
| 섹션 상자 제목 8649 `sec.label` | 안전 — 서버 상수(server.js:3408) |
| 지수 티커 8754 · 8773 `item.name` | 안전 — 서버 상수(INDEX_TARGETS, 5622 · 5651 · 5788) |
| 저장 패널 2980–2981 | 출력은 안전(esc) — 단 plainText 자체는 상-2 |
| 인쇄 9944–9947 | 안전 — esc, bodyEl.innerHTML 은 이미 그려진 내용을 다시 꺼낸 것 |
| 알림 4420 · fallback 10131 · emptyBoxHtml/popupWaitHtml 호출부 | 안전 — textContent 또는 고정 문구 |
| 언론사 목록 6954 · 6966 | 안전 — esc |

## 평가하지 못한 것
- 브라우저 실제 실행 : 상-2 onerror 실행, R1 textContent 풀기는 표준 동작으로 판단
- 네이버 · SSE 실제 응답 : 서버 가공 함수를 따라가 판단
- Firefox/Safari 에서 하-1(javascript: + target=_blank)
- Supabase 저장·조회 왕복 실측(가짜 Supabase 미기동)
- SCFI 축 라벨(현재 :7309)의 날짜 모양별 결과

## 고칠 때 메모 (단계 10 참고)
가장 효과 큰 수정 = 화면 카드 7곳(8353 · 8354 · 8388 · 8390 · 9809 · 9811 은 esc, 9563 은 textContent) — 이것만으로 상-1 과 R1 이 함께 막힌다. 다음은 plainText → DOMParser(상-2). 서버 stripHtml 순서 변경은 보고만.
