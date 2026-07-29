# Insight 기능 인수인계

> 이 문서 하나로 새 창(새 세션)에서 이어서 작업할 수 있게 정리한 것.
> 최종 갱신: 2026-07-29 (push 상태 표시만 정정)

## 한 줄 요약

각 기사에 **`💡 Insight` 버튼(녹색)**이 있다. 누르면 제미나이가 원문을 읽고
**① 물류 관점 · ② General** 두 관점의 인사이트를 팝업으로 보여준다.
기존 `주요 내용`(deep-brief) 기능을 본떠 만든 것이다.

## 현재 상태 (중요)

- Insight 기능 자체는 **A~D 전부 push 완료**. 아래 커밋 흐름:
  `f868ade`(최초 추가) → `85f81d5` → `4bbacc8` → `c5ab1e2` → `334c34f` → D 항목까지.
- 그 뒤로는 **속도 쪽 작업**만 이어졌다. Insight 는 `주요 내용`과 같은 Gemini 호출 경로를
  쓰므로 모델·상한을 바꾸면 **Insight 응답 속도도 같이 바뀐다**. 최신 상황은 [PERFORMANCE.md](PERFORMANCE.md) 참고.
  - 2026-07-27 밤 기준 1순위 모델이 `gemini-3.1-flash-lite` 로 바뀌었다(`255d4c0`).
- 이 문서 `INSIGHT-인수인계.md` 도 2026-07-29 부터 git 에 함께 커밋된다(참고용).

## 지금까지 한 작업 (시간순)

### A. Insight 버튼 최초 추가 (커밋 f868ade)
- 서버 `GET /api/insight` 엔드포인트 + 화면 팝업 모달 + 버튼.
- deep-brief(`주요 내용`)와 **완전히 같은 구조**로 만듦.

### B. 버튼 색 · 프롬프트 · 모바일 (커밋 85f81d5) — 3가지
1. **버튼 색을 녹색으로**
   - `emerald` → 순수 `green` 으로 교체.
   - 현재 클래스: `bg-green-500/20 hover:bg-green-500/30 text-green-300 border-green-500/50`
2. **인사이트 물류 관점을 "물류사 사업기회" 관점으로 재작성**
   - `server.js` 의 `INSIGHT_PROMPT` 전면 수정.
   - AI 역할 = "종합물류기업 신사업 전략가". 기사에서 물류사가 잡을
     사업기회(신규 수요·화주·제휴/인수·신규 서비스·리스크)를 **창의성 최대로** 발굴.
   - 문체 = **간결·핵심만, 한 문장에 인사이트 하나**. 본문에 없는 사실은 지어내지 않는 규칙 유지.
3. **모바일에서 4개 버튼 한 줄로**
   - 기존: 모바일에서 `주요 내용 / 원문 보기 / Insight / 관련 기사` 가 2줄로 접힘.
   - `actionsHtml()` 을 반응형으로: 모바일은 작게, `sm:`(데스크톱)는 기존 크기 복원.
     - 글자 `text-[0.68rem] sm:text-[0.8rem]`, 아이콘 `w-2.5 h-2.5 sm:w-3 sm:h-3`,
       여백 `px-1.5 sm:px-2`, 컨테이너 간격 `gap-1 sm:gap-1.5`.
   - 실측(375px): 4개 버튼 모두 같은 줄(동일 top), 264px 폭에 수납 ✅.
   - 실측(desktop): 글자 12px·아이콘 11.25px·여백 7.5px 로 원래대로 복원 ✅.

### C. 팝업 다듬기 (커밋 4bbacc8 → c5ab1e2 → 334c34f)
- `주요 내용` 팝업 안에도 Insight 버튼 추가(`openInsightFromBrief()`), 버튼 색 진하게.
- 카드 라벨을 **`물류 관점 Insight` / `General Insight`** 로 확정.
  (85f81d5 때 잠깐 `롯데글로벌로지스 사업기회` 였다가 되돌림 — 지금 코드 기준은 `물류 관점 Insight`.)
- 헤더 텍스트 2pt 확대, points 문장을 **개조식 종결('~함/~음/~임')** 로 바꾸는 규칙을 프롬프트에 추가.
- 팝업 줄간격·여백 확대.

### D. 회사명 제거 + 줄간격 축소 (2026-07-26, push 완료)
1. **회사 실명 금지** — `INSIGHT_PROMPT` 에서 '롯데글로벌로지스'를 전부 '물류사 / 종합물류사'로 교체하고
   금지 규칙 한 줄 추가: *"특정 물류회사의 실명을 절대 쓰지 마라. 주체는 항상 '물류사'로만 표현하라."*
   - 실제 호출로 검증 완료: 결과 문장이 "물류사는 …" 으로 나옴 ✅.
2. **문장 안 줄간격 축소** — summary/points 의 `leading-loose` → `leading-snug`.
   - 문장 **사이** 간격(`space-y-3`)은 그대로 두고, 한 문장이 여러 줄로 넘어갈 때만 좁힘.
   - 실측: 줄간격 배수 **2.0 → 1.38**, 요약 2줄 69px → **46px**, 물류 카드 275px → **200px**.

## 파일별 핵심 위치 (grep 키워드)

### 서버 — `server.js` (⚠️ **CRLF 줄바꿈 유지**)
- `INSIGHT_PROMPT` — 프롬프트 상수. 물류사 사업기회 관점. **여기를 조정하면 인사이트 톤이 바뀜.**
  회사 실명 금지 규칙과 개조식 종결 규칙이 [절대 규칙] 절에 들어 있다.
- `/api/insight` — 엔드포인트. `/api/deep-brief` 바로 다음.
- `insightCache` — URL 기준 6시간 TTL 캐시(deep-brief의 `briefCache`와 별개).
  ⚠️ 프롬프트를 고쳐도 **같은 URL은 6시간 동안 옛 결과가 나온다.** 확인하려면 서버 재시작 또는 다른 기사로 테스트.
- 구조: `fetchArticleTextSmart()` 원문 확보 → 짧으면 `desc` 폴백(`partial=true`)
  → 본문 3500자로 잘라 `callGemini()` → JSON 파싱 반환.

### 화면 — `news-insight-naver.html` (⚠️ **LF 줄바꿈 유지**)
- `actionsHtml` — 버튼 4개 묶음. 반응형 크기(`sz`, `ic` 변수)와 Insight 녹색 버튼.
- `openInsight` — 버튼 클릭 핸들러. `/api/insight` 호출(`openBrief`와 대칭).
- `openInsightFromBrief` — `주요 내용` 팝업 안의 Insight 버튼.
- `insightHtml` / `insightSectionHtml` — 관점 2개 카드 렌더.
  - 물류 = 금색(`gold`)+`package` 아이콘, 라벨 `물류 관점 Insight`
  - General = 파란색(`wire`)+`globe` 아이콘
  - 줄간격은 이 함수 안 `leading-*` 클래스로 조정한다.
- `insight-modal` — 팝업 모달 DOM(`z-[65]`). 본문 `#insight-body`, 안내문 `#insight-note`, 링크 `#insight-link`.
- `lightbulb` — `ICON_PATHS` 의 버튼 아이콘.

## 다음 세션이 확인/판단할 것

1. **줄간격 1.38이 적당한지** — 너무 빡빡하면 `leading-normal`(1.5) 로 한 단계 완화.
2. **인사이트 품질** — 물류사 사업기회가 기대만큼 창의적·구체적인지 본다.
   부족하면 `INSIGHT_PROMPT` 를 더 조인다(예: 사업영역별 예시 문장 추가, 분량 규칙 강화).
3. **물류 무관 기사 검증** — 물류와 거리가 먼 기사에서 억지 연결이 아닌지 확인.
   필요 시 "관련성이 낮으면 낮다고 인정" 규칙을 프롬프트에 추가.
4. **성능** — Insight는 6시간 캐시만 있고 프리워밍은 안 함(주요 내용도 안 함).
   캐시·프리워밍·네이버 동시호출 슬롯을 건드릴 땐 **반드시 `PERFORMANCE.md` 먼저 읽기.**
   응답 속도가 느리다고 느껴지면 그건 Insight 코드가 아니라 **Gemini 모델 문제**일 가능성이 크다.
   `/api/gemini-models?test=1&long=1` 로 먼저 재 볼 것 (사용법은 PERFORMANCE.md).

## 로컬 실행 / 배포

- 로컬: `.claude/launch.json` 의 `newsinsight` 설정. (포트 3000 사용 중이면 자동 포트)
- 배포: `origin/main` 에 push → Render 자동 배포. **push 전 사용자 확인 필요.**
