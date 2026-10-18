# 코드 리뷰 재점검 — 클라우드 세션 인수인계 (2026-10-14)

브랜치 `review/cleanup` (기준 main 699f154). **코드는 아직 한 줄도 고치지 않았다.** 이 폴더(`docs/review/`)는 리뷰 기록이며, 정리(단계 10)가 끝나면 지워도 된다.

## 1. 지금 어디까지 왔나

- 사용자 요청 : 단계 1~8 을 **모델/노력을 표대로 바꿔 가며** 다시 점검한다. 처음에는 전부 Sonnet(낮음)으로만 돌렸다.
- **한 단계씩 하고, 끝나면 멈춰서 사용자 승인을 받는다.**
- 완료 : 단계 1 재점검 → [findings/stage1-recheck.md](findings/stage1-recheck.md) (사용자에게 보고함)
- 완료 : 단계 2 재점검 → [findings/stage2-recheck.md](findings/stage2-recheck.md)
- 완료 : 단계 3 재점검 → [findings/stage3-recheck.md](findings/stage3-recheck.md) (2026-10-15)
- 완료 : 단계 4 재점검 → [findings/stage4-recheck.md](findings/stage4-recheck.md) (2026-10-17)
- 완료 : 단계 5 재점검 → [findings/stage5-recheck.md](findings/stage5-recheck.md) (2026-10-18)
- 완료 : 단계 6a 재점검 → [findings/stage6a-recheck.md](findings/stage6a-recheck.md) (2026-10-18)
- 완료 : 단계 6b 재점검 → [findings/stage6b-recheck.md](findings/stage6b-recheck.md) (2026-10-18)
- 완료 : 단계 7 재점검 → [findings/stage7-recheck.md](findings/stage7-recheck.md) (2026-10-18)
- 완료 : 단계 8 재점검 → [findings/stage8-recheck.md](findings/stage8-recheck.md) (2026-10-18)
- 완료 : 단계 9 → findings/stage9-verdict.md · 단계 10 (묶음 A·B) · 단계 11 (검증 + diff 리뷰) → review-findings.md 끝
- **다음 : 단계 11 에서 새로 찾은 R1(사진 네이버 대체 빠짐) · R2(Insight 오류 덮어쓰기) 고칠지 사용자 결정 → 배포(push) 승인.**

| # | 단계 | 범위 | 모델 | 노력 | 이전(Sonnet low) 결과 |
|---|---|---|---|---|---|
| 1 | 정적 조사 | 두 파일 | Sonnet | medium | ✅ 재점검 끝 (Opus) |
| 2 | 서버 보안 | server.js 1–1415, 3744–4150 | **Opus** | **high** | ✅ 재점검 끝 (stage2-recheck.md) |
| 3 | 캐시·프리워밍·본문 추출 | server.js 1417–2843, 6102–6288 | **Opus** | **xhigh** | ✅ 재점검 끝 (stage3-recheck.md) |
| 4 | API 라우트·AI·시세 | server.js 2843–6101 (3744–4150 제외) | Sonnet | medium | ✅ 재점검 끝 (stage4-recheck.md) |
| 5 | 화면 저장·동기화·로그인·설정 | html 2691–6415 | **Opus** | **high** | ✅ 재점검 끝 (stage5-recheck.md) |
| 6a | 화면 출력 이스케이프(XSS) | html 전체 JS | **Opus** | **high** | ✅ 재점검 끝 (stage6a-recheck.md) |
| 6b | 화면 검색·렌더링·차트·모바일 | html 6415–10143 | Sonnet | medium | ✅ 재점검 끝 (stage6b-recheck.md) |
| 7 | CSS·마크업·테마 | html 1–2691, privacy.html | Sonnet | low | ✅ 재점검 끝 (stage7-recheck.md) |
| 8 | 저장소 정리 | package.json · sql/ · 디자인 폴더 | Haiku | low | ✅ 재점검 끝 (stage8-recheck.md) |

각 단계 방법 :
1. 단계별 세부 항목은 [code-review-cleanup.md](code-review-cleanup.md) 3장, 공통 규칙은 [findings/COMMON-RULES.md](findings/COMMON-RULES.md) (에이전트 지시문에 그대로 넣는다).
2. 지시문에 **이전 결과(findings/stageN.md)** 를 같이 주고 "이 결과가 맞는지 확인 + 놓친 것 찾기"를 시킨다. 이전 결과의 "못 본 것" 줄이 우선 점검 대상.
3. 결과는 `findings/stageN-recheck.md` 로 쓰고 사용자에게 쉬운 말로 보고 → 멈춤.
4. 줄 번호는 main 699f154 기준이다. **단, 그 뒤 SCFI 커밋(c175529 · 5728476)으로 html 이 바뀌어 작업 파일과는 안 맞는다** (CSS 1485 · 마크업 2254 에서 22줄 줄어 2254 이후는 −22, 7118 · 8745 근처에서 또 바뀜). 리뷰는 `git show 699f154:news-insight-naver.html > <스크래치패드>/html-699f154.html` 사본으로 하고 그 줄 번호로 적는다. server.js 는 그대로라 맞다.

## 2. 시험 서버 띄우기 (로그인 우회 · 가짜 Supabase)

로컬 `.env` 는 저장소에 없다. 서버를 띄우려면 클라우드 환경에 **환경변수 `NAVER_CLIENT_ID` · `NAVER_CLIENT_SECRET`** 이 있어야 한다 (사용자가 클라우드 환경 설정에 넣어야 함). 없으면 정적 검토만 하고, 실제 요청 시험은 "평가하지 못한 것"에 적는다.

```bash
npm ci
node docs/review/tools/fake-supabase.js &        # :54321 가짜 로그인 + 빈 표
PORT=3100 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_KEY=test SUPABASE_ANON_KEY=test \
  ADMIN_EMAILS=tester@example.test SUPABASE_CACHE_SYNC=off KEY_ENCRYPTION_SECRET=test-secret-only-for-local \
  node server.js &
TOKEN=$(node docs/review/tools/token.js)          # 10시간짜리 가짜 토큰
curl -s -H "Authorization: Bearer $TOKEN" localhost:3100/api/me   # 200 이면 준비 끝
```

- **캐시 사본 저장·복원까지 시험할 때 (단계 3 방식)** : 가짜를 `fake-supabase-log.js` 로 바꾸고 `SUPABASE_CACHE_SYNC=on` 으로 띄운다. **`on` 을 꼭 적는다** — 빼면 로컬 `.env` 의 값이 읽힌다. 저장 요청마다 바이트 수 · JSON 정상 여부 · 짝 없는 서로게이트 수 · 깨진 글자(U+FFFD) 수가 기록 파일에 한 줄씩 남는다. `GET :54321/__dump` 는 저장된 열쇠별 크기.
  ```bash
  FAKE_LOG=/tmp/fake-supabase.log node docs/review/tools/fake-supabase-log.js &
  PORT=3100 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_KEY=test SUPABASE_ANON_KEY=test \
    ADMIN_EMAILS=tester@example.test SUPABASE_CACHE_SYNC=on KEY_ENCRYPTION_SECRET=test-secret-only-for-local \
    node server.js &
  ```
- **진짜 Supabase 주소·키는 절대 쓰지 않는다.** 위처럼 가짜로 덮어쓴다.
- `keywords.json` 이 없으면 프리워밍 경고가 나오는데 정상이다.
- 기준선(단계 0) 값은 [review-findings.md](review-findings.md) 참고.

## 3. 검색 도구 (`docs/review/tools/`, 저장소 루트에서 실행)

| 파일 | 하는 일 |
|---|---|
| `fake-supabase.js` | 가짜 Supabase (로그인 확인 + 빈 표) |
| `fake-supabase-log.js` | 위와 같고, 저장 요청 내용을 기록 · 깨진 JSON 은 400 PGRST102 로 거부 (단계 3) |
| `scan.js` | 한 번만 나오는 이름 · 몸통 밖에서 안 불리는 함수 · 쓰기만 하는 변수 |
| `pairs.js` | 두 파일 제외어 쌍 비교 |
| `handlers.js` | onclick 등이 부르는 함수가 정의돼 있는지 |
| `ids.js` | getElementById 대상 id 가 마크업에 있는지 |
| `params.js` | 서버 라우트별로 읽는 query/body 값 |

## 4. 꼭 지킬 것

- 보호 목록(code-review-cleanup.md 2-1)은 보고만, 고치자는 제안 금지.
- 단계 1~8 은 읽기 전용. 수정은 단계 9 재검증 → 사용자 선택 → 단계 10.
- `origin/main` push = Render 자동 배포. **절대 사용자 승인 없이 main 에 push 하지 않는다.** 이 브랜치(`review/cleanup`) push 는 배포되지 않는다.
- 사용자는 코딩 초보자. 한국어로 쉽게, 무엇을·왜·측정값을 함께.
