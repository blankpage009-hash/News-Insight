# NewsInsight

네이버 검색 API를 프록시해 뉴스를 카테고리별로 보여주는 단일 페이지 앱.

- `server.js` — Express 프록시. 단일 파일, **줄바꿈 CRLF**
- `news-insight-naver.html` — 화면 전체. 단일 파일, **줄바꿈 LF**
- 배포 : Render. `origin/main` 에 push하면 자동 배포됨 (push 전에 확인받을 것)
- 로컬 실행 : `.claude/launch.json` 의 `newsinsight` 설정 사용
- **v3 다크 테마(Phase 11) 진행 중 — 개인화 P11 보다 먼저** (2026-10-10 사용자 결정). 작업 브랜치 `v3-dark`, 계획·진행 기록은 [REDESIGN-v3.md](docs/REDESIGN-v3.md) "Phase 11 계획" 절 (한 단계씩, 끝나면 멈추고 확인)
- **개인화 작업 (다크 테마 다음, P11 통합 검증·배포 남음)** — 구글 로그인·허용 사용자·좋아요/싫어요·계정별 설정·개인 AI 키. 계획·결정·진행 기록은 [PERSONALIZATION.md](docs/PERSONALIZATION.md) (P0 부터 한 단계씩, 끝나면 멈추고 확인)

## 로딩 속도 개선 작업

진행 중인 성능 작업은 [PERFORMANCE.md](docs/PERFORMANCE.md) 에 정리돼 있다.
캐시 · 프리워밍 · 네이버 동시 호출 슬롯을 건드리기 전에 그 문서를 먼저 읽을 것.
특히 "작업할 때 조심할 것" 절에 반복해서 발목을 잡힌 함정들이 있다.

## 사용자에 대해

코딩 초보자다. 한국어로, 쉽게 설명한다.
무엇을 왜 바꿨는지와 실제 측정값을 같이 알려주는 걸 선호한다.
