# 단계 7 CSS·마크업·테마 (Sonnet low) — 원본 보고 요약 (단계 9 에서 재검증)
죽은 CSS 후보 (모두 위험도 하, 로컬 검증 Y) :
1. `.panel-more` 및 `.panel-more:hover, .panel-more.is-on` — html:596-603. `grep -n -- "panel-more" news-insight-naver.html privacy.html docs/*.md` → 선언 외 0건
2. `.bc-save.is-card` (+hover) — html:1259-1260. briefSaveBtnHtml 호출 2곳(8387, 9808) 모두 'row' → is-card 안 쓰임
3. `.label-wide` — html:266. docs/REDESIGN.md:284 에 "Phase 3에서 붙인다" 언급만
4. `.loading-ring` — html:694, 709, 1689. `.pr-ring` 과 묶인 규칙이라 `.loading-ring` 이름만 빼야 함
(`.news-row` / `.top-story` 는 [삭제] 표식 주석만 남음 → 건드리지 않음)
privacy.html : 내용·링크 현재 기능과 일치. 하드코딩 색(#fff 등)으로 다크 테마 안 따름 = 동작 변경 필요 후보(하).
다크 테마 변수 누락 : 새 문제 없음.
못 본 것 : `c-${x}` 같은 다른 템플릿 조합, [class*=...] 선택자.
