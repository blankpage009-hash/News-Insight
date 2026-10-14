# 단계 6a 화면 출력 이스케이프 XSS (Opus high) — 원본 보고 요약 (단계 9 에서 재검증)
방법 : grep innerHTML|insertAdjacentHTML|outerHTML|document.write → 82줄 전수. 3100 페이지 콘솔에서 무해한 표시(window.__xss)로 재현, node 로 stripHtml 실행.
상-1. 기사 제목·요약을 esc 없이 HTML 로 넣음 — html:8353,8354,8388,8390,9809,9811,9563. 근본 : server.js:1418 stripHtml 이 태그 제거 **뒤에** &lt; 를 < 로 복원. `stripHtml('&lt;img src=x onerror=alert(1)&gt;')` → `<img src=x onerror=alert(1)>` (node 실측). 평범한 기사 `&lt;CES 2026&gt; 개막` 도 화면에 " 개막"만 남음. CSP 0건. 보안+버그/상/Y
  수정안 : 화면 `${esc(item.title)}`, `${esc(lead)}`, brief-title 은 textContent. 서버 stripHtml 순서 변경은 캐시 내용이 바뀌어 보호 목록(PERFORMANCE.md:441)과 충돌 → 보고만
상-2. `plainText()`(html:9920)가 detached div.innerHTML 로 태그를 지움 → <img onerror> 실행됨. 호출 2979(페이지 열 때마다), 3657, 4081, 9750, 9822, 9873, 9932. 저장 기사는 기기 간 동기화 → 영구 반복. 보안/상/Y. 수정안 : DOMParser 사용
중-1. 관리자 섹션 이동 기록(movedRawFor 3912~3926, server.js:505~538)을 통한 저장형 XSS 전파 — 상-1 이 먼저 터져야 함, 상-1 고치면 막힘
하-1. `articleLink` html:6811~6816 이 javascript: 주소 통과 (looksLikeArticleUrl 6797 도 통과). 현재는 target=_blank 때문에 Chromium 에서 실행 안 됨. server.js:913 cleanSavedArticle 도 길이만 검사
하-2. renderError html:8098 `<p>${message}</p>` — 현재는 고정 문구라 안전, 구조상 위험
하-3. SCFI 날짜 그대로 삽입 html:7163, 7384, 7451, 7285
안전 확인 표 : briefHtml/Insight, 로그인 화면, 관리자 목록, 언론사, 키워드, 모델 목록, 검색어 표시 등 다수(원본 보고 참고)
못 본 것 : 실제 네이버 응답 형태, Firefox/Safari, 관리자 PUT 전체 흐름
