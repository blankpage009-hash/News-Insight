# P1 준비물 가이드 (구글 로그인 · Supabase · 환경변수 · 테이블)

> [PERSONALIZATION.md](PERSONALIZATION.md) 의 P1 단계. **코드는 바꾸지 않습니다.** 아래 6단계를 사용자가 직접 하면 P2(로그인 구현)를 시작할 수 있습니다.
> 결정 8에 따라 콘솔 설정 · SQL 실행 · 키 입력은 **사용자가 직접** 합니다. 비밀번호 · 키 · 시크릿은 **채팅에 붙여 넣지 마세요.** (확인이 필요하면 "넣었다/안 넣었다"만 알려 주세요.)
> 화면 이름은 구글/Supabase 가 가끔 바꿉니다. 이름이 조금 달라도 같은 메뉴를 찾으면 됩니다.

## 한눈에 보기

| 단계 | 어디서 | 하는 일 | 걸리는 시간 |
|---|---|---|---|
| 1 | Supabase | 지금 서버가 쓰는 키가 올바른 종류인지 확인 (**2단계 SQL 전에 필수**) | 3분 |
| 2 | Supabase | 테이블 만들기 + 잠금(RLS) 켜기 — [sql/personalization-p1.sql](sql/personalization-p1.sql) | 5분 |
| 3 | 구글 클라우드 | 로그인용 OAuth 클라이언트 만들기 | 10분 |
| 4 | Supabase | 구글 로그인 켜기 + 돌아올 주소 등록 | 5분 |
| 5 | 내 PC | 암호화 열쇠 만들기 | 1분 |
| 6 | Render + 내 PC `.env` | 환경변수 3개 등록 | 5분 |

---

## 1단계. 서버 키 종류 확인 (먼저!)

2단계에서 **기존 `app_settings` 테이블에 잠금을 걸기** 때문에, 서버가 쓰는 `SUPABASE_SERVICE_KEY` 가 진짜 "서비스(비밀) 키"가 아니면 잠금을 거는 순간 **키워드 설정 · 캐시 저장이 멈춥니다.** (anon 키를 잘못 넣어 두었어도 지금은 잠금이 없어서 동작하고 있을 수 있습니다.)

1. Supabase 대시보드 → 프로젝트 선택 → **Project Settings → API Keys** (예전 화면: *API*).
2. 두 종류의 키가 보입니다.
   - 공개용 : `anon` (또는 `publishable`, `sb_publishable_...`)
   - 비밀용 : `service_role` (또는 `secret`, `sb_secret_...`) — **절대 브라우저/깃에 노출 금지**
3. Render 대시보드 → 서비스 → **Environment** 에서 `SUPABASE_SERVICE_KEY` 를 열어, 위 **비밀용** 키와 같은 값인지 눈으로 비교합니다. (앞 10글자와 끝 4글자만 보면 충분합니다.)
4. 다르거나 공개용(anon)이 들어 있으면 → 비밀용 키로 바꾸고 재배포한 뒤 2단계로 갑니다.

> 로컬 `.env` 의 `SUPABASE_SERVICE_KEY` 도 같은 방식으로 확인하세요. `.env` 는 `.gitignore` 에 들어 있어 깃에 올라가지 않습니다.

## 2단계. 테이블 만들기 + 잠금(RLS) 켜기

1. Supabase 대시보드 → **SQL Editor → New query**.
2. [sql/personalization-p1.sql](sql/personalization-p1.sql) 의 내용을 **통째로** 복사해 붙여 넣고 **Run**.
3. 맨 아래 확인 쿼리 결과에서 **일곱 줄 모두 `rls_on = true`** 인지 봅니다.
   - `app_settings` · `allowed_users` · `user_settings` · `user_ai_keys` · `article_votes` · `saved_articles` · `read_marks`
4. 여러 번 실행해도 안전합니다. 중간에 에러가 나면 에러 문구를 알려 주세요.

**RLS 를 정책 없이 켜는 이유** : 브라우저는 테이블을 직접 읽지 않고 항상 우리 서버를 거칩니다. 정책이 하나도 없으면 브라우저용 키(anon)로는 **어떤 행도 읽거나 쓸 수 없고**, 서버(service 키)만 통과합니다. 가장 단순하고 안전한 구성입니다.

**잠금 후 바로 확인** (서버가 여전히 Supabase 에 쓰는지)
- 로컬에서 서버를 켜고(`.claude/launch.json` 의 `newsinsight`) 화면이 정상으로 뜨는지 봅니다.
- 서버 로그에 `[경고] SUPABASE_URL / SUPABASE_SERVICE_KEY 가 없어...` 가 **없어야** 합니다.
- 운영(Render)은 `https://news-insight.onrender.com/api/settings/keywords` 가 200 으로 열리면 정상입니다.
- 문제가 생기면 SQL 파일 맨 아래 "되돌리기" 두 줄을 실행하면 원래대로 돌아갑니다.

## 3단계. 구글 OAuth 클라이언트 만들기

1. <https://console.cloud.google.com> → 상단에서 프로젝트 선택 (없으면 **새 프로젝트**, 이름 예: `newsinsight`).
2. 메뉴 **Google Auth Platform**(예전 이름: *APIs & Services → OAuth consent screen*) → **시작하기**.
   - 앱 이름 : `NewsInsight` · 지원 이메일 : 본인 · 대상(Audience) : **외부(External)** · 연락처 이메일 : 본인.
3. **대상(Audience)** 에서 게시 상태를 확인합니다.
   - **"테스트"** 상태면 지정한 테스트 사용자만 로그인되고 **7일마다 로그인이 풀립니다.**
   - 이 앱은 이메일 · 프로필 같은 **기본 정보만** 쓰므로 **"프로덕션으로 푸시(앱 게시)"** 해도 구글 심사가 필요 없습니다. 게시하는 쪽을 권장합니다.
   - 누가 쓸 수 있는지는 구글이 아니라 **우리 허용 목록(allowed_users)** 이 정합니다.
4. **클라이언트 → 클라이언트 만들기**
   - 애플리케이션 유형 : **웹 애플리케이션**
   - 이름 : `NewsInsight web`
   - **승인된 리디렉션 URI** 에 아래 한 줄을 넣습니다. (**앱 주소가 아니라 Supabase 주소입니다.**)

     ```
     https://<프로젝트ID>.supabase.co/auth/v1/callback
     ```

     `<프로젝트ID>` 는 Supabase 의 Project Settings → General 의 *Reference ID* (또는 `SUPABASE_URL` 의 앞부분)입니다.
   - 승인된 JavaScript 원본은 비워 둬도 됩니다.
5. 만들면 **클라이언트 ID** 와 **클라이언트 보안 비밀번호(Secret)** 가 나옵니다. 다음 4단계에 바로 붙여 넣을 것이므로 창을 닫지 마세요. (Secret 은 메모장 · 채팅에 남기지 않습니다.)

## 4단계. Supabase 에서 구글 로그인 켜기

1. Supabase → **Authentication → Sign In / Providers → Google** → **Enable**.
2. 3단계의 **Client ID** 와 **Client Secret** 을 붙여 넣고 저장.
3. **Authentication → URL Configuration**
   - **Site URL** : `https://news-insight.onrender.com`
   - **Redirect URLs** 에 아래를 추가합니다. (로그인 후 돌아올 수 있는 주소 목록)

     ```
     https://news-insight.onrender.com/**
     http://localhost:3000/**
     ```

     로컬에서 `autoPort` 때문에 3000 이 아닌 포트로 뜨면 그 포트도 같은 형식으로 추가합니다.
4. 같은 화면 근처의 **"Allow new users to sign up"** 은 켜 둔 채로 둡니다. (끄면 신규 구글 계정이 로그인 자체를 못 해서, 신청 → 승인 흐름이 막힙니다. 접근 통제는 우리 서버의 허용 목록이 합니다.)

## 5단계. 암호화 열쇠 만들기 (`KEY_ENCRYPTION_SECRET`)

개인 AI 키를 서버에 저장할 때 쓰는 열쇠입니다. PowerShell 에서 한 줄 실행하면 무작위 32바이트가 나옵니다.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- 출력된 문자열을 복사해 **비밀번호 관리자 등 안전한 곳에 백업**합니다.
- **분실하거나 바꾸면 이미 저장된 사용자 AI 키를 전부 못 읽습니다.** (모두 다시 입력해야 함) 한번 정하면 바꾸지 않습니다.
- 채팅 · 깃 · 소스코드에 넣지 않습니다.

## 6단계. 환경변수 등록

필요한 값은 3개입니다. **Render 와 내 PC `.env`** 양쪽에 넣습니다. (로컬 테스트용 + 운영용)

| 이름 | 값 | 어디서 구하나 |
|---|---|---|
| `SUPABASE_ANON_KEY` | Supabase **공개용** 키 (`anon` / `publishable`) | 1단계의 API Keys 화면. 서버가 로그인 토큰을 확인할 때와 브라우저 로그인에 씁니다. 공개용이라 노출돼도 되지만 2단계 잠금이 켜져 있어야 안전합니다 |
| `ADMIN_EMAILS` | 관리자 구글 이메일, 여러 명이면 쉼표로 구분 (예: `me@gmail.com,sub@gmail.com`) | 본인 구글 계정. 소문자로 적습니다 |
| `KEY_ENCRYPTION_SECRET` | 5단계에서 만든 문자열 | 5단계 |

- Render : 서비스 → **Environment → Add Environment Variable**. 저장하면 자동 재배포되는데, **P1 단계에서는 코드를 바꾸지 않았으므로** 재배포돼도 동작은 그대로입니다.
- 로컬 : 프로젝트 루트의 `.env` 에 `이름=값` 한 줄씩 추가합니다.
- 기존 `ADMIN_TOKEN` 은 **지우지 않습니다.** P2 에서 구글 로그인으로 대체한 뒤 함께 지웁니다.
- `SUPABASE_ANON_KEY` 는 브라우저로도 내려가므로, **비밀용(service) 키를 실수로 넣지 않도록** 값 앞부분을 다시 확인하세요. (service 키가 브라우저에 나가면 RLS 를 우회해 전체 데이터가 노출됩니다.)

---

## 끝났는지 확인하는 체크리스트

- [ ] 1단계 : Render 의 `SUPABASE_SERVICE_KEY` 가 비밀용 키임을 확인했다
- [ ] 2단계 : SQL 실행 후 일곱 줄 모두 `rls_on = true`
- [ ] 2단계 : 잠금 후에도 로컬/운영 화면과 `GET /api/settings/keywords` 가 정상
- [ ] 3단계 : 구글 OAuth 클라이언트 생성, 리디렉션 URI 가 `https://<프로젝트ID>.supabase.co/auth/v1/callback`
- [ ] 4단계 : Supabase 에서 Google 활성화, Site URL · Redirect URLs 등록
- [ ] 5단계 : `KEY_ENCRYPTION_SECRET` 을 만들어 안전한 곳에 백업했다
- [ ] 6단계 : Render 와 `.env` 에 `SUPABASE_ANON_KEY` · `ADMIN_EMAILS` · `KEY_ENCRYPTION_SECRET` 등록

모두 체크되면 "P1 끝났다"고 알려 주세요. 그러면 P2(로그인 + 허용 관문)를 시작합니다.

## 자주 막히는 곳

| 증상 | 원인 / 해결 |
|---|---|
| 나중에 로그인 시 `redirect_uri_mismatch` | 3단계 리디렉션 URI 가 Supabase 주소와 한 글자라도 다름. 끝의 `/` · `http`/`https` 확인 |
| 로그인 후 엉뚱한 주소(localhost 등)로 돌아옴 | 4단계 Site URL / Redirect URLs 누락 |
| 7일마다 로그인이 풀림 | 3단계 게시 상태가 "테스트". 프로덕션으로 게시 |
| 2단계 직후 키워드 저장이 안 됨 | 1단계 미확인 — 서버 키가 비밀용이 아님. 키 교체 또는 SQL 맨 아래 되돌리기 |
