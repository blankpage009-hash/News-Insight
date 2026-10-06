# Beyond News v3.0 — 화면 전체 리디자인

v2(어두운 금색 톤 · 좌측 사이드바 + 우측 마켓 레일 3단)를 새 시안의
**밝은 바탕 · 레드(#ec3013) · 직각(모서리 0) · Archivo 글꼴** 디자인으로 바꾼다.
원칙은 v2 와 같다 : **시안 우선, 기능은 유지.** v2 기록은 [REDESIGN.md](REDESIGN.md) 에 있다.

- 시안 원본 : `Beyond News Redesign/` (Claude Design 번들 HTML 4개 — 브라우저로 열어야 보인다)
- 대상 파일 : `news-insight-naver.html`(LF) · 기사 사진 단계만 `server.js`(CRLF)
- 작업 순서 : **첫 화면(2a) → Sub Page(팝업) → Mobile → App Icon** (사용자 지정)

| 시안 파일 | 내용 |
|---|---|
| `Beyond News 첫 화면 시안.html` | 1a·1b·1c 초안 3종, **2a 카드형 + 오른쪽 패널(채택)**, 3a·3b·3c 로고. 2a 헤더 로고는 **3c 칼럼** |
| `Beyond News Sub Page.html` | 1a 주요 내용 · 1b Insight(두 관점 나란히) · 1c 관련 기사 · 1d 지수 차트 · 1e 설정(화면 설정 + 관리자 Setting 한 창) |
| `Beyond News Mobile.html` | iPhone 402px. 하단 탭 브리핑·검색·저장·설정, 카드 스와이프, 목록형, 전체 화면 시트, 검색 탭(랭킹 Top10), 저장 탭 |
| `Beyond News App Icon.html` | 앱 아이콘 6종 (1a 칼럼 · 1b 레드 칼럼 · 1c 이니셜 B · 1d 1면 · 1e 신호 · 1f 1면 블랙) |

시안 디자인 값(실측) : 배경 `#f3f2f2` · 면 `#eae9e9` · 글자 `#201e1d` · 강조 `#ec3013` · 보조글자 `#605d5d` · 연한 레드 `#fff2ef`
· 하락 파랑 `oklch(0.52 0.17 258)` · LIVE 초록 `oklch(0.55 0.15 150)` · 모서리 0 · 글꼴 Archivo 400/600/800.

---

## 버전 관리

- `v2-final` 태그 = v2 마지막 배포본(`c4366f6`). 되돌릴 때 기준점.
- 작업은 **`v3` 브랜치**에서만 한다. `main`(=Render 자동 배포)은 출시 때만 머지한다.
- Phase 마다 커밋 + 사용자 확인. 출시 = `v3` → `main` 머지 + 태그 `v3.0` → push(승인 후).
- `package.json` version = `3.0.0`.

---

## 결정된 사항 (2026-10-06)

| # | 항목 | 지금(v2) | 시안 | 결정 |
|---|---|---|---|---|
| 1 | 화면 골격 | 좌측 사이드바 + 본문 + 우측 마켓 레일 | 가로 카테고리 탭 + 오른쪽 패널 | 시안대로. 하위 섹션 → 탭 아래 칩 줄 / 섹션 필터 → 깔때기 드롭다운 / Admin Setting → 헤더 설정 아이콘 / 저장한 기사 → 오른쪽 패널 "전체 보기" |
| 2 | 지수 | 우측 레일 세로 목록 | 헤더 아래 가로 한 줄(흐르지 않음) | 시안대로 (v2 결정 #2 뒤집기). 차트 팝업 유지. SCFI 는 운임지수 섹션 패널 유지 |
| 3 | 브리핑 | TOP 카드 + 번호 행, "BRIEFING" | 카드 캐러셀 + 카드/목록 토글, "The Daily Brief" | 시안대로. 건수는 설정값, 기본 10 |
| 4 | 섹션 화면 | 섹션 상자 목록 | 시안에 없음 | 같은 토글 적용, 섹션은 기본 목록형 |
| 5 | 테마 | 다크/라이트/시스템 | 밝은 것 하나 | 밝은 화면 고정. 다크·시스템은 설정에 **껍데기만**, 구현은 마지막 Phase 11 |
| 6 | 글꼴 | Pretendard + JetBrains Mono | Archivo | Archivo(Google Fonts) 추가. Archivo(영문·숫자) → Pretendard(한글) |
| 7 | 기사 사진 | 없음 | 카드 1/3 크기 사진 | **작은 썸네일** + 출처. 사진 없는 카드 모양도 만든다 |
| 8 | Insight 내용 | B2 : 핵심 판단 · 기회/리스크 · 지표 칩 | 핵심 문장 + 불릿 | B2 데이터 유지, 모양만 시안 스타일. 서버 프롬프트 안 건드림 |
| 9 | 패널 토글 | "마켓 레일 표시" | — | "오른쪽 패널 표시" 로 이름만 바꿔 같은 저장값 재사용 |
| 10 | 설정 | 화면 설정 팝업 + 관리자 화면 따로 | 한 팝업, 왼쪽 탭 | 시안대로 (Phase 8) |
| 11 | 모바일 하단 탭 | 브리핑·섹션·키워드 랭킹·저장 | 브리핑·검색·저장·설정 | 시안대로 (Phase 9) |
| 12 | 로고 | RSS 3D 아이콘 | 3c 칼럼 | 시안대로, SVG 로 그린다 |

- 루트의 `icon.png` 는 실제 방송사 로고 스타일을 닮아 쓰지 않는다.

---

## 단계

**공통 규칙** : 색·글꼴(Phase 1)은 모든 폭에 적용하고, 레이아웃 변경(Phase 2~8)은 **1024px 이상에만** 적용한다.
좁은 화면은 Phase 9 전까지 v2 구조(드로어·하단 탭)를 그대로 둔다 → 어느 Phase 에서 멈춰도 모든 폭이 동작한다.

| Phase | 내용 | 모델 · 노력 |
|---|---|---|
| 0 준비 | 파일 복구 · 시안 커밋 · `v2-final` 태그 · `v3` 브랜치 · version 3.0.0 · 이 문서 | Sonnet 5.5 · low |
| 1 토큰·글꼴·로고 | `:root` 색 변수 교체 · 밝은 화면 고정 · 모서리 0 · Archivo · 헤더 로고 3c · LIVE 시계 | Sonnet 5.5 · medium |
| 2 골격 교체 ★ | 사이드바 → 가로 탭 + 칩 줄 · 필터 → 깔때기 · 레일 → 지수 가로 줄 + 오른쪽 패널 · 헤더 설정 아이콘 | Opus 5.5 · high |
| 3 Daily Brief 카드 | 캐러셀(드래그·← →·01/10·진행 막대) + 카드/목록 토글 · 사진 없는 모양 먼저 · 읽음·저장 이식 | Sonnet 5.5 · high |
| 4 오른쪽 패널 | 키워드 랭킹 Top5 · 저장 기사 + 이어보기 · 전체 보기 | Sonnet 5.5 · medium |
| 5a 사진 서버 | `/api/news-images` + 전용 캐시 + 동시 수 제한 + SSRF 차단 → main 에 서버만 먼저 배포(승인) → Render 실측 | Opus 5.5 · high |
| 5b 사진 화면 | 지연 로딩 썸네일 · `referrerpolicy="no-referrer"` · 실패 시 숨김 | Sonnet 5.5 · medium |
| 6 섹션 화면 | 섹션·검색 결과·저장 화면 새 스타일 · SCFI 패널 | Opus 5.5 · medium |
| 7 Sub Page 팝업 | 주요 내용 · Insight · 관련 기사 · 지수 차트 · PDF | Sonnet 5.5 · medium |
| 8 설정 한 창 | 화면 설정 + 관리자 Setting 탭 팝업 · 테마 껍데기 버튼 · 비밀번호 잠금 유지 | Opus 5.5 · high |
| 9 Mobile | 402px · 하단 탭 · 스와이프 · 44px 행 · 전체 화면 시트 · 검색 탭 · 제스처 충돌 점검 | Opus 5.5 · high |
| 10 App Icon | 6종 중 선택 → SVG → PNG(180·192·512) · apple-touch-icon · 파비콘 | Sonnet 5.5 · low |
| 11 다크·시스템 테마 | 다크 색 세트 · 껍데기 버튼 활성화 · 전 화면 두 테마 점검 | Opus 5.5 · medium |
| 12 출시 v3.0 | 전 화면 점검 · 머지 · 태그 `v3.0` · push(승인) · Render 확인 | Sonnet 5.5 · low |

### Phase 2 체크리스트 (v2 에서 실제로 걸렸던 함정)

- `#search-input` 은 "검색 중인가" 판단의 원본(16곳) → **지우지 말고 숨긴다**.
- 요소를 지울 때 **선택자 전역 검색** 필수 (`canStartPull`, `onNavTouchStart` 가 id 를 참조).
- 헤더 높이가 바뀌면 `updateStickTop()` 확인.
- **id 선택자는 `lg:hidden` 을 이긴다** → 보이기/숨기기는 `@media` 한 곳에서.
- 색·투명도 잴 때 `* { transition:none; animation:none }` 끼우고 잰다.
- ← → 키는 입력칸에 커서가 있으면 무시.

### 기사 사진

[REDESIGN.md](REDESIGN.md) 의 "D6 메모" 7개 주의사항을 그대로 따른다. 착수 전 [PERFORMANCE.md](PERFORMANCE.md) "작업할 때 조심할 것" 절을 읽는다.

---

## 진행 상황

- [x] **Phase 0** 준비 (2026-10-06)
- [ ] Phase 1 토큰·글꼴·로고 ← 다음

### Phase 0 에서 한 것 (2026-10-06)

- `news-insight-naver.html` 이 작업 폴더에서 지워져 있었다(커밋에는 있었음) → `git restore` 로 되살렸다.
  **이 PC 는 `core.autocrlf=true` 라 그냥 되살리면 CRLF 로 풀린다.** LF 규칙을 지키려고
  `git -c core.autocrlf=false restore` 로 다시 꺼냈다. 파일을 git 에서 새로 꺼낼 때마다 같은 주의가 필요하다.
- `main` 에 D6 메모 + 시안 폴더를 커밋(`32bfbac`, push 안 함) → `v2-final` 태그 → `v3` 브랜치.
- `beyond news_icon.JPG` 는 `apple-touch-icon.jpg` 와 같은 파일이라 커밋하지 않았다.
