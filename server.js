// server.js
// 네이버 검색 API(뉴스) 프록시 서버 - Naver API HUB 사용
//
// [이번 업데이트]
//  1) /api/briefing : 카테고리 균형(속보 쏠림 방지) 라운드로빈 선발
//  2) /api/article-summary : 원문 본문에서 잡음 제거 후 핵심 문장 N개(기본 2개)만 반환
//  3) /api/all/sections : perSection 파라미터로 노출 개수 조절
//  4) /api/{물류|경제|증시|스포츠}/digest : 하위 섹션 기사를 모아 중요한 것만 엄선
//
// [정확도 고도화 업데이트]
//  [H] DOMAINS      : 카테고리별 '맥락 단어(context)' / '제외 단어(exclude)' 사전
//  [I] refineByDomain : 사명(주체) + 맥락 2중 게이트 → '한진관광 여행' 같은 오탐 제거
//  검색어 보강      : '한진' → '한진택배' / '한진 물류' (네이버 단계에서 이미 AND)
//
// 실행: npm install → node server.js → http://localhost:3000

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // v2
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const PORT = process.env.PORT || 3000;

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.warn('[경고] .env 에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 없습니다.');
}

// ECOS(한국은행) 무료 API 키. 발급 전까지는 고정값으로 대체.
// 발급: https://ecos.bok.or.kr → 마이페이지 → Open API 활용신청
const ECOS_API_KEY = process.env.ECOS_API_KEY;
if (!ECOS_API_KEY) {
  console.warn('[경고] .env 에 ECOS_API_KEY 가 없어 한국 기준금리는 고정값으로 표시됩니다.');
}

// node-fetch v2는 기본 타임아웃이 없어, 배포 환경에서 외부망이 막히면 요청이 무한 대기한다.
// 그 사이 함께 묶인 다른 요청까지 응답이 안 나가는 걸 막기 위해 모든 외부 fetch에 타임아웃을 강제한다.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'news-insight-naver.html'));
});

// -----------------------------------------------------------------
// [깨우기용] /healthz  ―  되돌릴 땐 이 블록만 통째로 지우면 된다.
//   Render 무료 플랜은 15분간 요청이 없으면 서버를 재우고, 다시 깨는 데 30~60초가 걸린다.
//   외부 크론(cron-job.org)이 10분마다 여기를 찔러 잠들지 않게 한다. 설정 방법은 PERFORMANCE.md 참고.
//
//   [중요] 여기서 네이버·Gemini 같은 외부 API를 절대 부르지 않는다.
//   10분마다 도는 요청이라 조금만 무거워도 하루 144번씩 한도를 그냥 태운다.
//   깨우는 것 자체가 목적이고, 캐시는 기동 30초 뒤 프리워밍이 알아서 채운다(WARM_START_DELAY).
// -----------------------------------------------------------------
app.get('/healthz', (req, res) => {
  // 중간 캐시가 대신 응답해 버리면 요청이 서버까지 오지 않아 깨우는 의미가 없어진다.
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),  // 초. 들를 때마다 900 미만이면 그새 잠들었다는 뜻
    warming,                               // 지금 프리워밍이 도는 중인지
    cache: { resp: respCache.size, article: articleTextCache.size },
  });
});

// -----------------------------------------------------------------
// 키워드 설정 저장소
//   기기(브라우저)마다 따로 저장되던 localStorage 대신 서버에 보관한다.
//   → 웹·아이폰·아이패드가 같은 서버를 바라보므로 설정이 자동으로 동기화된다.
//
//   [저장 위치] Supabase(Postgres) — 배포 환경(Render 등)은 재배포·재시작 때마다
//   컨테이너 디스크가 초기화되므로, 로컬 파일에만 두면 설정이 사라진다.
//   로컬 파일은 Supabase가 응답하지 않을 때를 위한 읽기 캐시로만 쓴다.
// -----------------------------------------------------------------
const KEYWORDS_FILE = path.join(__dirname, 'keywords.json');
const SETTINGS_TABLE = 'app_settings';
const KEYWORDS_ROW_KEY = 'keywords';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
if (!SUPABASE_ENABLED) {
  console.warn('[경고] SUPABASE_URL / SUPABASE_SERVICE_KEY 가 없어 키워드 설정을 로컬 파일에만 저장합니다.');
  console.warn('       배포 환경에서는 재배포 시 설정이 사라집니다.');
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// 파일 캐시: Supabase가 죽었을 때만 읽는다. 쓰기는 Supabase 성공 후 따라 쓴다.
function readKeywordsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};   // 파일이 없거나 깨졌으면 빈 설정(=프론트의 기본값 사용)
  }
}

function writeKeywordsFile(keywords) {
  try {
    // 임시 파일에 먼저 쓰고 교체 → 저장 중 서버가 죽어도 기존 캐시가 깨지지 않는다.
    const tmp = KEYWORDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(keywords, null, 2), 'utf8');
    fs.renameSync(tmp, KEYWORDS_FILE);
  } catch (e) {
    console.error('[키워드 파일 캐시 저장 실패]', e.message);   // 캐시일 뿐이므로 실패해도 진행
  }
}

async function readKeywordsFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}`
    + `?key=eq.${encodeURIComponent(KEYWORDS_ROW_KEY)}&select=value`;
  const res = await fetchWithTimeout(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const value = Array.isArray(rows) && rows.length ? rows[0].value : null;
  return value && typeof value === 'object' ? value : {};
}

async function writeKeywordsToSupabase(keywords) {
  // Prefer: resolution=merge-duplicates → key가 이미 있으면 UPDATE, 없으면 INSERT
  const url = `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}?on_conflict=key`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      key: KEYWORDS_ROW_KEY,
      value: keywords,
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
}

app.get('/api/settings/keywords', async (req, res) => {
  if (!SUPABASE_ENABLED) return res.json({ keywords: readKeywordsFile(), source: 'file' });
  try {
    const keywords = await readKeywordsFromSupabase();
    writeKeywordsFile(keywords);                       // 다음 장애 때 쓸 캐시 갱신
    res.json({ keywords, source: 'supabase' });
  } catch (e) {
    // Supabase를 못 읽었다. 캐시를 내려주되, 이게 최신이 아닐 수 있음을 알린다.
    console.error('[키워드 조회 실패 → 파일 캐시 사용]', e.message);
    res.json({ keywords: readKeywordsFile(), source: 'cache', stale: true });
  }
});

app.post('/api/settings/keywords', async (req, res) => {
  const kw = req.body && req.body.keywords;
  if (!kw || typeof kw !== 'object' || Array.isArray(kw)) {
    return res.status(400).json({ error: 'keywords 객체가 필요합니다.' });
  }
  // 저장 전 형태를 정리한다. (include/exclude 문자열 배열만 남김)
  const clean = {};
  Object.keys(kw).forEach((key) => {
    const v = kw[key] || {};
    const pick = (arr) => (Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : []);
    clean[key] = { include: pick(v.include), exclude: pick(v.exclude) };
  });

  if (!SUPABASE_ENABLED) {
    writeKeywordsFile(clean);
    return res.json({ ok: true, keywords: clean, source: 'file' });
  }
  try {
    // Supabase 저장이 성공해야만 '저장됨'으로 응답한다. 파일에만 쓰고 성공이라 답하면
    // 다음 재배포 때 조용히 사라져 사용자가 잃어버린 줄도 모르게 된다.
    await writeKeywordsToSupabase(clean);
    writeKeywordsFile(clean);
    res.json({ ok: true, keywords: clean, source: 'supabase' });
  } catch (e) {
    console.error('[키워드 저장 실패]', e.message);
    res.status(500).json({ error: '설정을 저장하지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// 유틸리티
// -----------------------------------------------------------------
function stripHtml(str = '') {
  return str
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toIsoDate(pubDate) {
  const d = new Date(pubDate);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function guessSource(originalLink, link) {
  try {
    return new URL(originalLink || link).hostname.replace('www.', '');
  } catch {
    return '출처 미상';
  }
}

// 요약을 문장 단위로 분리 (자르지 않고 전부 반환)
function splitSummary(desc) {
  const trimmed = (desc || '').trim();
  if (!trimmed) return ['요약 없음'];
  const sentences = trimmed
    .split(/(?<=[.!?])\s+|(?<=다\.)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [trimmed];
}

function textContainsTerm(text, term) {
  const lower = (text || '').toLowerCase();
  const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => lower.includes(t));
}

function itemMatchesAnyTerm(item, terms) {
  const combined = `${item.title} ${item.summary.join(' ')}`;
  return terms.some((term) => textContainsTerm(combined, term));
}

// -----------------------------------------------------------------
// [추가] 검색어 파싱 : 공백 = AND, 콤마 = OR
//   '롯데 한진'  -> ['롯데 한진']        (한 덩어리 → 두 단어 모두 포함해야 통과)
//   '롯데, 한진' -> ['롯데', '한진']     (각각 검색 후 합침 → 둘 중 하나만 있어도 통과)
// -----------------------------------------------------------------
function parseQuery(q) {
  return String(q || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// -----------------------------------------------------------------
// [F] 동의어·표기 확장 : 같은 뜻인데 다르게 쓰는 말도 함께 검색
// -----------------------------------------------------------------
const SYNONYMS = [
  { re: /\bVCM\b/i, adds: ['Value Creation Meeting', '밸류크리에이션미팅'] },
  { re: /롯데글로벌로지스/, adds: ['롯데택배'] },
  { re: /CJ대한통운/i, adds: ['대한통운'] },
  { re: /현대글로비스/, adds: ['글로비스'] },
  { re: /LX판토스/i, adds: ['판토스'] },
  { re: /뉴욕증시/, adds: ['미국 증시'] },
  { re: /코스피/, adds: ['KOSPI'] },
  { re: /코스닥/, adds: ['KOSDAQ'] },
];

function expandTerm(term) {
  const out = [term];
  SYNONYMS.forEach(({ re, adds }) => {
    if (re.test(term)) adds.forEach((a) => out.push(term.replace(re, a).replace(/\s+/g, ' ').trim()));
  });
  return [...new Set(out)];
}

// -----------------------------------------------------------------
// [G] 매칭 강도
//   strict : 검색어의 모든 단어가 제목+요약에 있어야 통과
//   loose  : 검색어의 단어 중 하나라도 있으면 통과 (결과 0건일 때 마지막 수단)
// -----------------------------------------------------------------
function tokensOf(term) {
  return String(term || '').toLowerCase().split(/\s+/).filter(Boolean);
}
function itemText(it) {
  return `${it.title || ''} ${(it.summary || []).join(' ')}`.toLowerCase();
}
function matchBy(mode, it, terms) {
  const text = itemText(it);
  if (mode === 'loose') return terms.some((t) => tokensOf(t).some((k) => text.includes(k)));
  return terms.some((t) => {
    const ks = tokensOf(t);
    return ks.length > 0 && ks.every((k) => text.includes(k));
  });
}

// -----------------------------------------------------------------
// [H] 도메인 사전 : 카테고리별 '맥락 단어'와 '제외 단어'
//   context : 이 카테고리 기사라면 반드시 등장할 법한 단어
//   exclude : 이 단어가 제목에 있으면 카테고리가 아님 (예: 한진관광 → 여행)
// -----------------------------------------------------------------
const DOMAINS = {
  logistics: {
    context: ['물류','택배','배송','운송','화물','창고','풀필먼트','3PL','포워딩',
              '해운','항만','컨테이너','통관','물류센터','배차','라스트마일',
              '공급망','SCM','허브터미널','수출입','이커머스','유통',
              '운임','운임지수','SCFI','BDI','벌크','컨테이너선','항공화물'],
    exclude: ['관광','여행','트래블','패키지여행','항공권','호텔','리조트',
              '면세','골프','레저','유람선','크루즈','뮤지컬','공연'],
  },
  stock: {
    context: ['증시','코스피','코스닥','주가','지수','상장','시가총액','거래대금',
              '외국인','기관','공매도','나스닥','다우','S&P','장중','종가','급등','급락'],
    exclude: ['부고','인사이동','채용공고'],
  },
  economy: {
    context: ['금리','물가','환율','성장률','경기','수출','수입','고용','재정',
              '통화','한국은행','기재부','GDP','인플레이션','예산'],
    exclude: [],
  },
  society: {
    context: ['국회','정부','법안','검찰','경찰','판결','재판','대통령','여야',
              '지자체','시위','사고','수사','국정'],
    exclude: [],
  },
  global: {
    context: ['미국','중국','일본','유럽','EU','유엔','외교','정상회담','관세',
              '전쟁','국제','현지시간','백악관'],
    exclude: [],
  },
  // [추가] AI 도메인 : 인공지능 모델·기업·반도체 등 AI 맥락 단어
  ai: {
    context: ['AI','인공지능','생성형','거대언어모델','LLM','챗봇','모델','알고리즘',
              '머신러닝','딥러닝','학습','추론','데이터센터','GPU','반도체','가속기',
              '오픈AI','OpenAI','앤스로픽','Anthropic','클로드','Claude','챗GPT','GPT',
              '제미나이','Gemini','그록','Grok','엔비디아','NVIDIA','구글','마이크로소프트',
              '메타','네이버','카카오','AI반도체','서비스','기술','개발','출시'],
    exclude: [],
  },
  // [추가] 스포츠 도메인 : 경기/선수/리그 등 스포츠 맥락 단어
  sports: {
    context: ['경기','선수','감독','리그','우승','승리','패배','시즌','구단','팀',
              '득점','골','홈런','안타','승부','대표팀','월드컵','올림픽','결승','예선',
              '축구','야구','MLB','KBO','K리그','프리미어리그','챔피언스리그'],
    exclude: [],
  },
};

// 띄어쓰기 무시 비교 ('물류 센터' == '물류센터')
function compact(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }
function hitCount(text, words) {
  const t = compact(text);
  return (words || []).filter((w) => t.includes(compact(w))).length;
}

// -----------------------------------------------------------------
// [추가] 카테고리 정확도 검증
//  - 제목에 키워드가 있으면 = 그 기사의 '핵심 주제' → 통과
//  - 제목에 없으면 원문 본문을 읽어 '앞부분(리드문)'에 키워드가 있는지 확인
//    (기사 중간에 스쳐 지나가듯 언급만 된 기사는 탈락)
// -----------------------------------------------------------------
const LEAD_CHARS = 700;      // 리드문으로 볼 본문 앞부분 길이
const VERIFY_LIMIT = 20;     // 원문을 읽어볼 최대 후보 수(속도 보호)
// 원문 확인은 거의 전부 '네트워크 대기'다(측정: 대기 25.9초 / CPU 0.06초).
// 동시성이 낮으면 느린 언론사 한 곳이 워커 하나를 붙잡아 그 줄 전체가 밀린다.
// 6 → 20 으로 올려 느린 꼬리가 전체를 지연시키지 않게 한다.
const VERIFY_CONCURRENCY = 20;

// url -> { ts, text, lead }   (Map = 삽입순 유지 → LRU 로 씀)
//   lead=true 는 '리드문만 있는 항목'이라는 표시다. 정확도 검증에는 충분하지만
//   딥브리핑처럼 본문 전체가 필요한 곳에서는 다시 읽어야 한다.
const articleTextCache = new Map();
// 기사 본문은 한 번 게재되면 바뀌지 않는다. TTL을 짧게 둘 이유가 없고,
// 짧으면 같은 기사를 반복해서 다시 읽느라 느려진다. 6시간으로 둔다.
const ARTICLE_TTL = 1000 * 60 * 60 * 6;

// -----------------------------------------------------------------
// [속도] 본문 캐시 영속화
//   측정 결과 같은 요청이 캐시 미스일 때 6.4초, 히트일 때 0.13초였다(약 50배).
//   기존 캐시는 프로세스 메모리에만 있어 재배포·재시작마다 전부 날아갔고,
//   그래서 사용자는 늘 '콜드' 상태를 만났다. 디스크에 남겨 재시작을 견디게 한다.
//
//   - 저장은 성공한 본문만 (실패는 FAIL_TTL 2분짜리라 남길 가치가 없다)
//   - 본문은 4000자까지만 저장한다. 소비처가 검증 700자 / 딥브리핑 3500자라 충분하다.
//   - 항목 수 상한을 둬 무한 증식(메모리 누수)을 막는다.
//
//   [2단 저장]
//     1단 로컬 파일  : 빠르고 자주(1분) 쓴다. 재시작을 견딘다.
//     2단 Supabase  : 느리고 드물게(5분) 쓴다. '재배포'까지 견딘다.
//   Render 같은 배포 환경은 재배포 때 컨테이너 디스크가 통째로 초기화되므로
//   로컬 파일만으로는 부족하다. 키워드 설정과 같은 app_settings 테이블을 쓰므로
//   추가 마이그레이션(테이블 생성)은 필요 없다.
//
//   Supabase 사본은 전송량을 줄이려고 '리드문 800자'만 담는다. 이게 정확도
//   검증(700자)에 필요한 전부다. 본문 전체가 필요한 딥브리핑은 lead 표시를
//   보고 그때 다시 읽는다.
// -----------------------------------------------------------------
const CACHE_DIR = path.join(__dirname, '.cache');
const ARTICLE_CACHE_FILE = path.join(CACHE_DIR, 'article-text.json');
const ARTICLE_CACHE_MAX = 5000;   // 보관할 최대 기사 수
const ARTICLE_TEXT_MAX = 4000;    // 기사 1건당 저장할 최대 글자 수
const ARTICLE_SAVE_INTERVAL = 60 * 1000;

const ARTICLE_CACHE_ROW_KEY = 'article_cache';
const ARTICLE_LEAD_STORE = 800;          // Supabase 사본에 담을 글자 수
const SUPA_CACHE_MAX = 1500;             // Supabase 사본에 담을 최대 기사 수
// Supabase 쓰기는 드물게 한다. 사본이 1500건이면 한 번에 1MB가 넘어가는데,
// 프리워밍(30분)마다 쓰면 무료 티어 대역폭을 크게 잠식한다. 사본은 '재배포를
// 견디기 위한 예비본'일 뿐이라 최대 2시간 뒤처져도 손해가 거의 없다.
//   (재배포 직후 프리워밍이 60초 안에 최신분을 다시 채운다)
const SUPA_MIN_SAVE_GAP = 2 * 60 * 60 * 1000;

let articleCacheDirty = false;
let supaCacheDirty = false;
let supaLastSaved = 0;

function loadArticleCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(ARTICLE_CACHE_FILE, 'utf8'));
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    let n = 0;
    for (const [url, ts, text, lead] of raw) {
      if (!url || !text) continue;
      if (now - ts >= ARTICLE_TTL) continue;   // 이미 만료된 건 버린다
      articleTextCache.set(url, { ts, text, lead: Boolean(lead) });
      n++;
    }
    console.log(`[캐시] 로컬 파일에서 기사 본문 ${n}건을 불러왔습니다.`);
  } catch {
    /* 파일이 없거나 깨졌으면 빈 캐시로 시작 (정상 동작) */
  }
}

function saveArticleCache() {
  if (!articleCacheDirty) return;
  articleCacheDirty = false;
  try {
    const now = Date.now();
    const rows = [];
    for (const [url, v] of articleTextCache) {
      if (!v.text || now - v.ts >= ARTICLE_TTL) continue;
      rows.push([url, v.ts, v.text, v.lead ? 1 : 0]);
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // 키워드 파일과 같은 방식: 임시 파일에 쓰고 교체 → 저장 중 죽어도 안 깨진다
    const tmp = ARTICLE_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows), 'utf8');
    fs.renameSync(tmp, ARTICLE_CACHE_FILE);
  } catch (e) {
    console.error('[캐시 저장 실패]', e.message);   // 캐시일 뿐이라 실패해도 서비스는 계속
  }
}

// Supabase 사본 : 리드문만, 최근 것부터 SUPA_CACHE_MAX 건
async function saveArticleCacheToSupabase() {
  if (!SUPABASE_ENABLED || !supaCacheDirty) return;
  const now = Date.now();
  if (now - supaLastSaved < SUPA_MIN_SAVE_GAP) return;   // 너무 잦은 쓰기는 건너뛴다
  const prevSaved = supaLastSaved;
  supaCacheDirty = false;
  supaLastSaved = now;
  const rows = [];
  // Map은 오래된 것이 앞이므로 뒤에서부터 채워 '최근 것'을 남긴다
  const all = [...articleTextCache];
  for (let i = all.length - 1; i >= 0 && rows.length < SUPA_CACHE_MAX; i--) {
    const [url, v] = all[i];
    if (!v.text || now - v.ts >= ARTICLE_TTL) continue;
    rows.push([url, v.ts, v.text.slice(0, ARTICLE_LEAD_STORE)]);
  }
  try {
    const url = `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}?on_conflict=key`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{
        key: ARTICLE_CACHE_ROW_KEY,
        value: rows,
        updated_at: new Date().toISOString(),
      }]),
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error('[캐시 Supabase 저장 실패]', e.message);   // 로컬 파일은 이미 있으므로 서비스는 계속
    supaCacheDirty = true;      // 다음 회차에 다시 시도하되,
    supaLastSaved = prevSaved;  //   간격 제한에 걸려 2시간 묶이지 않게 되돌린다
  }
}

// 재배포 직후처럼 로컬 파일이 비었을 때 Supabase 사본으로 캐시를 채운다.
//   이미 메모리에 있는 항목(=로컬 파일이 더 온전함)은 덮어쓰지 않는다.
async function loadArticleCacheFromSupabase() {
  if (!SUPABASE_ENABLED) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}`
      + `?key=eq.${encodeURIComponent(ARTICLE_CACHE_ROW_KEY)}&select=value`;
    const res = await fetchWithTimeout(url, { headers: supabaseHeaders() }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    const rows = Array.isArray(body) && body.length ? body[0].value : null;
    if (!Array.isArray(rows)) return;

    const now = Date.now();
    let n = 0;
    for (const [u, ts, text] of rows) {
      if (!u || !text || articleTextCache.has(u)) continue;
      if (now - ts >= ARTICLE_TTL) continue;
      articleTextCache.set(u, { ts, text, lead: true });   // 리드문만 있는 항목
      n++;
    }
    if (n) console.log(`[캐시] Supabase에서 기사 리드문 ${n}건을 복원했습니다.`);
  } catch (e) {
    console.error('[캐시 Supabase 복원 실패]', e.message);   // 없으면 그냥 콜드로 시작
  }
}

// 캐시에 넣으면서 LRU 상한을 지킨다
function putArticleText(url, text) {
  const trimmed = text ? String(text).slice(0, ARTICLE_TEXT_MAX) : '';
  articleTextCache.delete(url);                      // 다시 넣어 '가장 최근'으로 이동
  articleTextCache.set(url, { ts: Date.now(), text: trimmed, lead: false });
  while (articleTextCache.size > ARTICLE_CACHE_MAX) {
    articleTextCache.delete(articleTextCache.keys().next().value);   // 가장 오래된 것부터
  }
  if (trimmed) { articleCacheDirty = true; supaCacheDirty = true; }
}

loadArticleCache();
loadArticleCacheFromSupabase();   // 비동기: 로컬 파일이 비어 있을 때를 메운다
setInterval(saveArticleCache, ARTICLE_SAVE_INTERVAL).unref();
// Supabase 사본은 프리워밍이 끝날 때 저장한다(SUPA_MIN_SAVE_GAP 으로 빈도 제한).
//   별도 타이머를 두면 같은 일을 두 곳에서 하게 되므로 두지 않는다.
['SIGINT', 'SIGTERM'].forEach((sig) =>
  process.once(sig, async () => {
    saveArticleCache();
    await saveArticleCacheToSupabase();   // 재배포 직전 마지막 사본을 남긴다
    // 응답 사본은 여기서 간격 제한을 무시한다. 지금 남기는 값이 가장 최신이고,
    //   바로 다음에 뜰 프로세스가 그걸 그대로 받아쓰기 때문이다.
    await saveRespCacheToSupabase(lastWarmKeys, { force: true });
    process.exit(0);
  })
);

// 지정한 밀리초만큼 잠깐 기다린다 (429 재시도·호출 간격 조절용)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function mapLimit(list, limit, worker) {
  const out = new Array(list.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (idx < list.length) {
        const i = idx++;
        out[i] = await worker(list[i]);
      }
    })
  );
  return out;
}

// -----------------------------------------------------------------
// [본문 추출 고도화]  "원문 본문을 읽지 못했습니다" 오류 대응
//
// 기존 문제
//  1) 태그 매칭이 <div ...>[\s\S]*?</div> (최소 매칭) 이라서, 본문 div 안에
//     또 다른 div(사진/광고/기자 프로필)가 있으면 '첫 번째 </div>'에서 잘려
//     본문이 200자 미만 → "읽지 못했습니다" 로 처리됐다. (가장 큰 원인)
//  2) 헤더가 빈약해서 언론사 봇 차단(403)에 걸렸다.
//  3) 타임아웃 4.5초라 느린 언론사는 무조건 실패.
//  4) 실패 결과(빈 문자열)를 30분이나 캐시해서, 재시도해도 계속 실패.
//
// 해결
//  A) 여는/닫는 태그 개수를 세는 '균형 잡힌 블록 추출'로 본문 전체를 가져온다.
//  B) 추출 순서를 다단계로: 네이버 본문 → JSON-LD(articleBody) → <article>
//     → 본문스러운 div → <p> 태그 총합 → og:description
//  C) 브라우저에 가까운 헤더 + 타임아웃 9초 + 데스크톱/모바일 UA 2회 시도
//  D) 실패는 2분만 캐시(짧게) → 다음에 다시 시도 가능
// -----------------------------------------------------------------
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://search.naver.com/',
};
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const FAIL_TTL = 1000 * 60 * 2; // 실패는 짧게만 캐시

// [A] 여는 태그/닫는 태그 개수를 세어서 블록을 '끝까지' 잘라낸다
function sliceBalanced(html, tag, startIdx) {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  re.lastIndex = startIdx;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth <= 0) return html.slice(startIdx, m.index + m[0].length);
    } else if (!/\/>$/.test(m[0])) {
      depth++;
    }
    if (re.lastIndex - startIdx > 400000) break; // 안전장치
  }
  return html.slice(startIdx, startIdx + 200000);
}

function findBlock(html, tag, attrRe) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let m;
  while ((m = open.exec(html))) {
    if (!attrRe || attrRe.test(m[0])) return sliceBalanced(html, tag, m.index);
  }
  return '';
}

// [개선] 블록 안에서 '링크(<a>) 글자'가 차지하는 비율(0~1)을 잰다.
//   비율이 높으면 = 목록/추천/메뉴/관련기사 묶음 → 본문이 아님.
function linkTextRatio(htmlBlock) {
  const all = stripHtml(htmlBlock || '');
  if (all.length < 40) return 0;
  const anchors = htmlBlock.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  const linkChars = anchors.reduce((n, a) => n + stripHtml(a).length, 0);
  return linkChars / all.length;
}

// [B] JSON-LD 안의 articleBody (많은 언론사가 이걸 넣어둔다 = 가장 깨끗한 본문)
function pickJsonLdBody(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const found = JSON.stringify(JSON.parse(m[1].trim()));
      const body = found.match(/"articleBody"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
      if (body && body.length > 200) return stripHtml(body.replace(/\\n/g, ' ').replace(/\\"/g, '"'));
    } catch { /* 형식이 깨진 JSON-LD는 무시 */ }
  }
  return '';
}

// [B] <p> 태그를 모두 모아 본문 재구성 (최후의 수단)
function pickParagraphs(html) {
  const ps = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
  const text = ps
    .filter((p) => linkTextRatio(p) < 0.4)   // [개선] 링크가 대부분인 문단(목록성) 제외
    .map((p) => stripHtml(p))
    .filter((t) => t.length > 30)
    .join(' ');
  return text;
}

function extractBodyFromHtml(html) {
  const candidates = [
    // 1) 네이버 뉴스 본문 (PC/모바일 공통 id)
    () => findBlock(html, 'div', /id=["'](?:dic_area|newsct_article|articleBodyContents|newsEndContents)["']/i),
    // 2) JSON-LD articleBody
    () => pickJsonLdBody(html),
    // 3) 표준 마크업
    () => findBlock(html, 'div', /itemprop=["']articleBody["']/i),
    () => findBlock(html, 'article', null),
    // 4) 본문스러운 id/class
    () => findBlock(html, 'div', /(?:id|class)=["'][^"']*(?:article[-_]?(?:body|view|content|txt)|news[-_]?(?:body|content|view)|entry[-_]?content|read[-_]?body|text[-_]?area|cont[-_]?body|view[-_]?con)[^"']*["']/i),
    () => findBlock(html, 'section', /(?:id|class)=["'][^"']*(?:article|news|content)[^"']*["']/i),
    // 5) 문단 총합
    () => pickParagraphs(html),
  ];

  let best = '';
  for (const get of candidates) {
    const rawBlock = get() || '';         // stripHtml 하기 전의 원본(링크 판별에 필요)
    const text = stripHtml(rawBlock);
    // [개선] '가장 긴 덩어리 선택'을 그대로 쓰지 않고,
    //   링크가 절반 이상인 덩어리(목록/추천/메뉴)는 본문 후보에서 뺀다.
    if (text.length > best.length && linkTextRatio(rawBlock) < 0.5) best = text;
    if (best.length >= 600) break; // 충분히 길면 더 안 찾는다 (속도)
  }
  if (best.length < 150) best = pickMeta(html, 'og:description') || best;
  return best.slice(0, 6000);
}

// [C] 한 URL을 UA를 바꿔가며 최대 2번 시도
async function fetchHtml(url) {
  const uas = [BROWSER_HEADERS['User-Agent'], MOBILE_UA];
  for (const ua of uas) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const r = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { ...BROWSER_HEADERS, 'User-Agent': ua },
      });
      clearTimeout(timer);
      if (r.ok) {
        const html = await r.text();
        if (html && html.length > 500) return html;
      }
    } catch { /* 다음 UA로 재시도 */ }
  }
  return '';
}

// 원문 페이지 본문 텍스트 추출 (실패 시 빈 문자열)
//   full=true : 본문 전체가 필요하다는 뜻. Supabase에서 복원한 '리드문만' 항목은
//               캐시 히트로 치지 않고 원문을 다시 읽는다. (딥브리핑 등)
async function fetchArticleText(url, { full = false } = {}) {
  if (!url || /^https?:\/\//i.test(url) === false) return '';
  const c = articleTextCache.get(url);
  const usable = c && !(full && c.lead);
  if (usable && Date.now() - c.ts < (c.text ? ARTICLE_TTL : FAIL_TTL)) return c.text;

  let text = '';
  try {
    const html = await fetchHtml(url);
    if (html) text = extractBodyFromHtml(html);
  } catch {
    text = '';
  }
  putArticleText(url, text);
  return text.slice(0, ARTICLE_TEXT_MAX);
}

// [D] 같은 기사를 가리키는 '읽어볼 만한 주소' 목록을 만든다
//     n.news.naver.com → m.news.naver.com(모바일)은 구조가 단순해 성공률이 훨씬 높다
function articleUrlCandidates(url, naverUrl) {
  const out = [];
  const push = (u) => { if (u && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
  push(url);
  push(naverUrl);
  [url, naverUrl].forEach((u) => {
    if (/^https?:\/\/n\.news\.naver\.com\//i.test(u || '')) push(u.replace('//n.news.naver.com', '//m.news.naver.com'));
    if (/^https?:\/\/news\.naver\.com\//i.test(u || '')) push(u.replace('//news.naver.com', '//m.news.naver.com'));
  });
  return out;
}

// 후보 주소를 차례로 읽어 '가장 긴 본문'을 고른다
//   요약·브리핑용이라 본문 전체가 필요하다 → full:true 로 읽는다
async function fetchArticleTextSmart(url, naverUrl, minLen = 200) {
  let best = '';
  for (const u of articleUrlCandidates(url, naverUrl)) {
    const t = await fetchArticleText(u, { full: true });
    if (t.length > best.length) best = t;
    if (best.length >= minLen) break;
  }
  return best;
}

// 기사 목록 중 '핵심 주제'가 키워드와 맞는 것만 남긴다
async function filterByCore(items, terms) {
  const passed = [];
  const pending = [];

  items.forEach((it) => {
    if (terms.some((t) => textContainsTerm(it.title, t))) passed.push(it);
    else pending.push(it);
  });

  const targets = pending.slice(0, VERIFY_LIMIT);
  const verified = await mapLimit(targets, VERIFY_CONCURRENCY, async (it) => {
    const body = await fetchArticleText(it.url);
    if (!body) return it; // [B] 원문 확인 불가 → 버리지 않고 살려둔다 (언론사 봇 차단이 잦음)
    const lead = body.slice(0, LEAD_CHARS);
    return terms.some((t) => textContainsTerm(lead, t)) ? it : null;
  });

  return passed.concat(verified.filter(Boolean));
}

// -----------------------------------------------------------------
// [I] 도메인(맥락) 검증
//   통과 조건
//     - 제목에 제외어 → 즉시 탈락
//     - 제목에 사명 O + 맥락어 1개 이상 → 통과
//     - 제목에 사명 X + 맥락어 2개 이상 → 통과
//     - 애매하면 원문 리드문을 읽어 맥락어 2개 이상일 때만 통과
// -----------------------------------------------------------------
const DOMAIN_VERIFY_LIMIT = 12; // 원문 확인 최대 건수(속도 보호)

async function refineByDomain(items, terms, domKey, excludeOverride) {
  const dom = DOMAINS[domKey];
  if (!dom) return items;

  // excludeOverride 가 null/undefined 이면 도메인 기본 제외어를 쓴다.
  // 배열(빈 배열 포함)이면 그 값을 그대로 쓴다. → 세팅에서 제외어를 비우면 제외 없음
  const excl = (excludeOverride == null) ? dom.exclude : excludeOverride;

  const pass = [];
  const pending = [];

  for (const it of items) {
    const head = `${it.title || ''} ${(it.summary || []).join(' ')}`;

    if (hitCount(it.title, excl) > 0) continue;   // 제목 제외어 → 탈락
    if (hitCount(head, excl) >= 2) continue;      // 요약에도 제외어 다수 → 탈락

    const subjectInTitle = terms.some((t) => textContainsTerm(it.title, t));
    const ctx = hitCount(head, dom.context);

    if (subjectInTitle && ctx >= 1) pass.push(it);
    else if (ctx >= 2) pass.push(it);
    else pending.push(it);
  }

  // 애매한 기사만 원문 리드문 확인
  const targets = pending.slice(0, DOMAIN_VERIFY_LIMIT);
  const rescued = await mapLimit(targets, VERIFY_CONCURRENCY, async (it) => {
    const lead = (await fetchArticleText(it.url)).slice(0, LEAD_CHARS);
    if (!lead) return null;                              // 확인 불가 → 정확도 우선(탈락)
    if (hitCount(lead, excl) >= 2) return null;
    return hitCount(lead, dom.context) >= 2 ? it : null;
  });

  return pass.concat(rescued.filter(Boolean));
}

// -----------------------------------------------------------------
// [추가] 유료·회원가입 전용 기사 걸러내기
//  1) 도메인/경로 기준 : 유료 구독 매체, 프리미엄 섹션
//  2) 제목·요약 문구 기준 : "유료회원", "회원 전용" 등
// -----------------------------------------------------------------
const PAYWALL_HOSTS = [
  // 국내 유료/구독 전용
  'premium.chosun.com',
  'plus.hankyung.com',
  'premium.mk.co.kr',
  'outstanding.kr',
  'themiilk.com',
  'bookjournalism.com',
  'thebell.co.kr',
  'ceoscoredaily.com',
  // 해외 유료 구독 매체
  'wsj.com',
  'ft.com',
  'bloomberg.com',
  'nytimes.com',
  'washingtonpost.com',
  'economist.com',
  'barrons.com',
  'nikkei.com',
  'thetimes.co.uk',
  'telegraph.co.uk',
  'businessinsider.com',
  'seekingalpha.com',
  'newyorker.com',
  'theatlantic.com',
  'foreignaffairs.com',
  'hbr.org',
  'medium.com',
];

// URL 경로에 이런 조각이 있으면 유료/회원 전용일 확률이 높음
const PAYWALL_PATH_PAT = /\/(plus|premium|members?|subscribe|subscription|paywall)(\/|$|\?)/i;

// 제목·요약에 이런 문구가 있으면 제외
const PAYWALL_TEXT_PAT =
  /(유료\s?기사|유료\s?회원|유료\s?콘텐츠|회원\s?전용|구독자\s?전용|프리미엄\s?기사|로그인\s?후\s?열람|더중앙플러스|더 중앙 플러스|한경\s?플러스|subscribers?\s+only|paywall)/i;

function isRestrictedItem(item) {
  const url = item.url || '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (PAYWALL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
    if (PAYWALL_PATH_PAT.test(u.pathname)) return true;
  } catch {
    /* URL 파싱 실패 시 텍스트 검사만 진행 */
  }
  const text = `${item.title || ''} ${(item.summary || []).join(' ')}`;
  return PAYWALL_TEXT_PAT.test(text);
}

// [속도] 네이버 검색 API 동시 호출 제한
//   섹션 20~30개를 Promise.all 로 한꺼번에 쏘면 네이버가 429(호출 초과)를 돌려준다.
//   그러면 400ms→800ms 물러섰다 재시도하느라 오히려 더 느려지고,
//   재시도가 또 429를 부르는 악순환이 생긴다.
//   동시에 나가는 요청 수를 묶어두면 429 자체가 거의 사라져 전체적으로 더 빠르다.
const NAVER_MAX_CONCURRENT = 6;

// [속도] 사용자 요청을 프리워밍보다 먼저 처리한다
//   프리워밍과 사용자 요청이 위 6슬롯을 똑같이 나눠 쓰면, 재배포 직후처럼
//   프리워밍이 한창 도는 중에 접속한 사람이 대기열 끝에 서게 된다. (실측 19초)
//   규칙은 하나다 : "사용자가 기다리고 있으면 프리워밍은 새 슬롯을 잡지 않는다."
//     - 기다리는 사용자가 없으면 프리워밍이 6슬롯을 다 쓴다 → 프리워밍도 안 느려진다.
//     - 사용자가 오면 프리워밍이 새로 잡는 것을 멈추고, 끝나는 순서대로
//       슬롯이 사용자에게 넘어간다 → 진행 중인 호출 하나(0.2초 남짓)만 기다리면 된다.
//   프리워밍이 계속 밀릴 수는 있지만, 프리워밍은 30분 주기의 '여유 작업'이라
//   사람이 기다리는 화면보다 뒤로 미뤄지는 게 맞다.
const warmFlag = new AsyncLocalStorage();
// 지금 돌고 있는 코드가 '프리워밍인지' 알아내기 위한 표식.
//   naverSearchRaw 까지 함수를 여러 단계 거치는데, 단계마다 인자를 하나씩 더
//   넘기지 않아도 되게 AsyncLocalStorage 를 쓴다. warmCache 가 이 안에서
//   작업을 실행하면 그 안의 모든 네이버 호출이 자동으로 프리워밍으로 인식된다.
const isWarming = () => warmFlag.getStore() === true;

let naverActive = 0;                // 지금 쓰고 있는 슬롯 수
const naverQueueUser = [];          // 사용자 대기열 (먼저 처리)
const naverQueueWarm = [];          // 프리워밍 대기열 (사용자 대기열이 빌 때만 처리)

function naverSlotAcquire(forWarm) {
  const yieldToUser = forWarm && naverQueueUser.length > 0;
  if (naverActive < NAVER_MAX_CONCURRENT && !yieldToUser) {
    naverActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => (forWarm ? naverQueueWarm : naverQueueUser).push(resolve));
}

function naverSlotRelease() {
  naverActive--;
  naverSlotPump();
}

// 슬롯이 비면 사용자 대기열부터 채우고, 사용자가 다 빠진 뒤에 프리워밍을 채운다.
function naverSlotPump() {
  while (naverActive < NAVER_MAX_CONCURRENT && naverQueueUser.length) {
    naverActive++;
    naverQueueUser.shift()();       // resolve 는 마이크로태스크로 미뤄지므로 카운터를 먼저 올린다
  }
  while (naverActive < NAVER_MAX_CONCURRENT && !naverQueueUser.length && naverQueueWarm.length) {
    naverActive++;
    naverQueueWarm.shift()();
  }
}

async function naverSearchRaw(query, display = 30, sort = 'date', start = 1) {
  await naverSlotAcquire(isWarming());
  try {
    return await naverSearchOnce(query, display, sort, start);
  } finally {
    naverSlotRelease();
  }
}

async function naverSearchOnce(query, display = 30, sort = 'date', start = 1) {
  const params = new URLSearchParams({
    query,
    display: String(Math.min(Number(display) || 30, 100)),
    start: String(Math.min(Math.max(Number(start) || 1, 1), 1000)),
    sort: sort === 'sim' ? 'sim' : 'date',
  });

  // 429(Rate Limited)는 잠깐 쉬면 대개 풀린다. 짧게 물러섰다가 두 번까지 다시 시도한다.
  //   재시도하지 않으면 그 섹션이 통째로 빈 결과가 되어 화면이 비어 보인다.
  const url = `https://naverapihub.apigw.ntruss.com/search/v1/news?${params.toString()}`;
  const headers = {
    'X-NCP-APIGW-API-KEY-ID': NAVER_CLIENT_ID,
    'X-NCP-APIGW-API-KEY': NAVER_CLIENT_SECRET,
  };

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetchWithTimeout(url, { headers }, 5000);
    if (res.status !== 429 || attempt >= 2) break;
    await sleep(400 * (attempt + 1));   // 400ms → 800ms
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`네이버 API 오류 (${query}):`, res.status, text);
    throw new Error(`네이버 API 오류 (${res.status})`);
  }

  const data = await res.json();
  return (data.items || [])
    .map((item) => ({
      title: stripHtml(item.title),
      summary: splitSummary(stripHtml(item.description)),
      source: guessSource(item.originallink, item.link),
      url: item.originallink || item.link,
      naverUrl: item.link, // [추가] 원문이 막혔을 때 우회용 네이버 뉴스 링크
      datetime: toIsoDate(item.pubDate),
    }))
    // 유료·회원가입 전용 기사 제외
    .filter((it) => !isRestrictedItem(it));
}

async function searchByTerms(terms, opts = {}) {
  const {
    display = 15,
    sort = 'date',
    dateFrom,
    dateTo,
    hours,
    verify = true,
    match = 'strict', // 'strict' | 'loose'
    expand = false,   // [F] 동의어 확장 사용 여부
    fetchCount,       // [D] 네이버에 몇 건 요청할지 (미지정 시 자동)
    domain,           // [I] 도메인(맥락) 검증 키 : 'logistics' | 'stock' | ...
    exclude = null,   // [설정] 사용자가 세팅에서 정한 '제외 키워드' (null이면 도메인 기본값)
    pages = 1,        // [다이제스트] 네이버 결과를 몇 페이지까지 받아올지 (대형 이슈에 묻힌 기사까지 확보)
  } = opts;

  // [D] 넉넉히 받아온 뒤 서버에서 추린다 (요청 비용은 동일)
  const per = Number(fetchCount) || Math.max(30, Math.min(100, (Number(display) || 15) * 4));

  // 여러 페이지를 받아올 때 시작 위치 목록 (네이버 start 최대 1000)
  const pageCount = Math.max(1, Number(pages) || 1);
  const starts = [];
  for (let p = 0; p < pageCount; p++) {
    const st = 1 + p * per;
    if (st > 1000) break;
    starts.push(st);
  }

  const resultsPerTerm = await Promise.all(
    terms.map(async (term) => {
      const queries = expand ? expandTerm(term) : [term]; // [F]
      const lists = await Promise.all(
        queries.flatMap((q) =>
          starts.map(async (st) => {
            try {
              return await naverSearchRaw(q, per, sort, st);
            } catch (e) {
              console.error(`[검색 실패] "${q}" start=${st}:`, e.message);
              return [];
            }
          })
        )
      );
      // 확장어로 찾은 기사도 '원래 검색어 또는 확장어' 중 하나에 맞으면 통과
      return lists.flat().filter((it) => matchBy(match, it, queries));
    })
  );

  let merged = resultsPerTerm.flat();

  const seen = new Set();
  merged = merged.filter((it) => {
    if (!it.url || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  if (dateFrom || dateTo) {
    const fromTs = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
    const toTs = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : Infinity;
    merged = merged.filter((it) => {
      if (!it.datetime) return false;
      const ts = new Date(it.datetime).getTime();
      return ts >= fromTs && ts <= toTs;
    });
  }

  // [추가] 기사 게재 시간 필터 (현재 시각 기준 N시간 이내)
  const hourNum = Number(hours);
  if (hourNum > 0) {
    const minTs = Date.now() - hourNum * 3600 * 1000;
    merged = merged.filter((it) => it.datetime && new Date(it.datetime).getTime() >= minTs);
  }

  // [E] 정확도순(sim)이면 네이버가 준 순서를 유지, 최신순(date)이면 시간 정렬
  const byDate = (a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0);
  if (sort !== 'sim') merged.sort(byDate);

  // 카테고리 정확도 검증 (원문 핵심 내용 확인) - 키워드 검색에서는 사용하지 않음 [A]
  if (verify) {
    merged = await filterByCore(merged, terms);
    if (domain) merged = await refineByDomain(merged, terms, domain, exclude); // [I] 맥락 검증
    if (sort !== 'sim') merged.sort(byDate);
  }

  // [설정] 사용자 지정 제외어 최종 적용
  //   도메인이 없거나(verify와 무관) 위 단계를 거치지 않은 경우에도 반드시 걸러낸다.
  merged = applyExcludeList(merged, exclude);

  return merged;
}

// [설정] 제외 키워드가 제목/요약에 있으면 그 기사를 목록에서 뺀다.
//   exclude 가 null 이거나 빈 배열이면 아무것도 걸러내지 않는다.
function applyExcludeList(items, exclude) {
  if (!Array.isArray(exclude) || !exclude.length) return items;
  return items.filter((it) => {
    const head = `${it.title || ''} ${(it.summary || []).join(' ')}`;
    return hitCount(it.title, exclude) === 0 && hitCount(head, exclude) < 2;
  });
}

// -----------------------------------------------------------------
// [설정] 프런트(화면)에서 보낸 '기사 가져오기 키워드' 적용
//   요청에 kw=<JSON> 형태로 온다.
//   kw = { "섹션키": { "include": ["단어",...], "exclude": ["단어",...] }, ... }
//   - include 가 있으면 그 섹션의 검색어(terms)로 사용한다.
//   - exclude 가 있으면 그 섹션의 제외어로 사용한다. (없으면 도메인 기본 제외어)
// -----------------------------------------------------------------
function parseKw(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch {
    return {};
  }
}

// 문자열 배열만 남기고 앞뒤 공백/빈값 정리
function cleanList(arr) {
  return Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : [];
}

// 섹션 정의(sec.key, sec.terms) + kw 설정 → 실제 사용할 { terms, exclude }
//   exclude 가 null 이면 도메인 기본 제외어를 쓴다는 뜻
function resolveSectionKw(kwMap, sec) {
  const o = (kwMap && kwMap[sec.key]) || {};
  const include = cleanList(o.include);
  const hasExclude = Array.isArray(o.exclude);
  return {
    terms: include.length ? include : sec.terms,
    exclude: hasExclude ? cleanList(o.exclude) : null,
  };
}

// -----------------------------------------------------------------
// 카테고리 설정
// -----------------------------------------------------------------
const LOGISTICS_SECTIONS = [
  { key: 'logistics_lotte', label: '롯데글로벌로지스',
    terms: ['롯데글로벌로지스', '롯데택배'], domain: 'logistics' },
  {
    key: 'logistics_competitor',
    label: '경쟁사',
    // [I] 사명 단독 대신 '사명 + 물류어' AND 조합으로 검색 → 애초에 여행 기사를 덜 가져온다
    terms: ['CJ대한통운', '한진택배', '한진 물류', '한진 택배',
            'LX판토스', '삼성SDS 물류', '현대글로비스'],
    domain: 'logistics',
  },
  { key: 'logistics_domestic', label: '국내 물류',
    terms: ['국내 물류', '국내물류'], domain: 'logistics' },
  { key: 'logistics_global', label: '글로벌 물류',
    terms: ['글로벌 물류', '해외 물류', '국제 물류'], domain: 'logistics' },
  { key: 'logistics_coupang', label: '쿠팡',
    terms: ['쿠팡 물류', '쿠팡로지스틱스서비스', '로켓배송', '쿠팡 풀필먼트'], domain: 'logistics' },
  { key: 'logistics_naver', label: '네이버',
    terms: ['네이버 물류', '네이버 도착보장', '네이버 풀필먼트', '네이버 커머스'], domain: 'logistics' },
  { key: 'logistics_freight', label: '운임지수',
    terms: ['SCFI', '항공화물 운임', '벌크 운임'], domain: 'logistics' },
];

// [추가] 증시 하위 카테고리
const STOCK_SECTIONS = [
  { key: 'stock_domestic', label: '국내',
    terms: ['코스피', '코스닥', '국내 증시'], domain: 'stock' },
  { key: 'stock_us', label: '해외',
    terms: ['뉴욕증시', '나스닥', '미국 증시', '다우지수'], domain: 'stock' },
  { key: 'stock_issue', label: '이슈 섹터',
    terms: ['테마주', '급등주', '수혜주', '증시 이슈'], domain: 'stock' },
];

// [추가] 스포츠 하위 카테고리 (포항스틸러스 / 국내축구 / 해외축구 / 해외야구 / 기타)
const SPORTS_SECTIONS = [
  { key: 'sports_pohang', label: '포항스틸러스',
    terms: ['포항스틸러스', '포항 스틸러스'], domain: 'sports' },
  { key: 'sports_kfootball', label: '국내축구',
    terms: ['K리그', '축구 국가대표', '국내축구'], domain: 'sports' },
  { key: 'sports_wfootball', label: '해외축구',
    terms: ['해외축구', '프리미어리그', '챔피언스리그', '손흥민', '이강인'], domain: 'sports' },
  { key: 'sports_baseball', label: '해외야구',
    terms: ['MLB', '메이저리그', '해외야구', '김하성', '이정후'], domain: 'sports' },
  { key: 'sports_etc', label: '기타',
    terms: ['농구', '배구', '골프 선수', '테니스', '스포츠'], domain: 'sports' },
];

// [추가] 경제 하위 카테고리 (거시경제/시장)
const ECONOMY_SECTIONS = [
  { key: 'economy_macro', label: '거시경제/시장',
    terms: ['환율', '유가', '원자재 가격', '금리', '물가', '기준금리', '국제유가'],
    domain: 'economy' },
];

const ALL_SECTIONS = [
  { key: 'breaking', label: '속보', terms: ['속보'], breaking: true },
  { key: 'logistics', label: '물류', terms: ['물류', '롯데글로벌로지스'], domain: 'logistics' },
  { key: 'economy', label: '경제', terms: ['경제 금리'], domain: 'economy' },
  { key: 'society', label: '정치/사회', terms: ['정치', '국회', '사건사고'], domain: 'society' },
  { key: 'global', label: '글로벌', terms: ['국제'], domain: 'global' },
  // [추가] AI 섹션 (글로벌 아래 · 증시 위)
  { key: 'ai', label: 'AI', terms: ['AI', '클로드', 'GPT', '제미나이', '그록', '엔비디아'], domain: 'ai' },
  { key: 'stock', label: '증시', terms: ['증시 코스피'], domain: 'stock' },
];

// -----------------------------------------------------------------
// 속보 전용 수집
//  - 조건1: 기사 제목에 '속보' 표기가 있는 기사만
//  - 조건2: 현재 시각 기준 1시간 이내 기사만
// -----------------------------------------------------------------
const BREAKING_WINDOW_MS = 60 * 60 * 1000; // 1시간

function isBreakingItem(it) {
  // [속보], <속보>, (속보), 속보= 등 다양한 표기 허용
  if (!/속보/.test(it.title || '')) return false;
  if (!it.datetime) return false;
  const age = Date.now() - new Date(it.datetime).getTime();
  return age >= 0 && age <= BREAKING_WINDOW_MS;
}

async function fetchBreaking(limit = 10, terms = ['속보'], exclude = null) {
  // 세팅의 '포함 키워드'를 검색 씨앗으로 쓰되, '제목에 속보 + 최근 1시간' 규칙은 유지한다.
  const seeds = (Array.isArray(terms) && terms.length) ? terms : ['속보'];
  // 엄격 필터라 후보를 넉넉히 받아온 뒤 걸러낸다
  const raw = await searchByTerms(seeds, { display: 30, sort: 'date', verify: false });
  let out = raw.filter(isBreakingItem);
  out = applyExcludeList(out, exclude);   // 세팅의 '제외 키워드' 적용
  out = collapseEvents(out, 'date');      // 같은 속보 여러 건은 하나로 합침(최신순)
  return out.slice(0, limit);
}

// -----------------------------------------------------------------
// [속도] 응답 캐시
//   지금까지 캐시되는 건 '기사 본문'뿐이었다. 검색 결과 자체는 저장하지 않아서
//   같은 화면을 새로고침할 때마다 네이버 검색 API를 20~30회 처음부터 다시 불렀다.
//   여기서는 '완성된 응답(JSON)'을 통째로 보관한다.
//
//   fresh 이내 : 그대로 돌려준다            → 네이버 호출 0회
//   stale 이내 : 일단 그대로 돌려주고,      → 사용자는 기다리지 않고,
//                뒤에서 조용히 새로 받아둔다   다음 사람이 최신 값을 받는다
//   stale 초과 : 새로 받을 때까지 기다린다
//
//   같은 키로 요청이 동시에 여러 개 들어와도 실제 계산은 한 번만 한다(중복 제거).
// -----------------------------------------------------------------
// 응답 1건이 큰 편이라(전체 화면 = 80KB 남짓) 개수를 넉넉하되 과하지 않게 잡는다.
// 실제로 쓰이는 조합은 '화면 종류 × 필터 조합'이라 수십 개 수준이다.
const RESP_CACHE_MAX = 120;
const respCache = new Map();      // key -> { ts, value }   (Map = 삽입순 유지 → LRU)
const respInflight = new Map();   // key -> Promise         (진행 중인 계산)
// 기동 직후 Supabase에서 캐시를 되살리는 동안 잠깐 걸어두는 빗장.
//   복원이 끝나면 null 이 되고, 그 뒤로는 아무 비용도 들지 않는다. (아래 복원 절 참고)
let respRestoreReady = null;

// 캐시 키를 짧게 유지하기 위한 간단한 해시 (djb2)
function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// 프런트가 보낸 kw 문자열을 그대로 키에 쓰지 않고, '실제로 검색에 쓰일 값'
// (섹션별로 확정된 포함/제외 키워드)으로 정규화해서 해시한다.
//   → 프리워밍이 만들어 둔 캐시와 화면 요청이 같은 키를 쓰게 된다.
function kwSig(sections, kwMap) {
  return shortHash(JSON.stringify(
    sections.map((sec) => {
      const { terms, exclude } = resolveSectionKw(kwMap, sec);
      return [sec.key, terms, exclude];
    })
  ));
}

function respCacheSet(key, value) {
  respCache.delete(key);                      // 다시 넣어 '가장 최근'으로 이동
  respCache.set(key, { ts: Date.now(), value });
  while (respCache.size > RESP_CACHE_MAX) {
    respCache.delete(respCache.keys().next().value);   // 가장 오래된 것부터
  }
}

function runProducer(key, producer) {
  const running = respInflight.get(key);
  if (running) return running;               // 이미 누가 만들고 있으면 그 결과를 같이 쓴다
  const p = (async () => {
    const value = await producer();
    respCacheSet(key, value);
    return value;
  })().finally(() => respInflight.delete(key));
  respInflight.set(key, p);
  return p;
}

async function cachedResponse(key, ttl, producer) {
  // 기동 직후 첫 손님은 복원이 끝나기 전에 도착한다. 여기서 잠깐(최대 3초) 기다려야
  //   복원된 값을 쓸 수 있다. 그냥 지나가면 캐시가 빈 것으로 보고 전부 새로 만든다.
  if (respRestoreReady) await respRestoreReady;

  const hit = respCache.get(key);
  const age = hit ? Date.now() - hit.ts : Infinity;

  if (hit && age < ttl.fresh) return hit.value;

  if (hit && age < ttl.stale) {
    // 조금 오래됐지만 쓸 만하다 → 기다리게 하지 않고 바로 주고, 갱신은 뒤에서 한다
    runProducer(key, producer).catch((e) => console.error('[캐시 갱신 실패]', key, e.message));
    return hit.value;
  }

  return runProducer(key, producer);
}

// 캐시 수명 (밀리초)
//   속보는 '최근 1시간 기사'만 보여주는 화면이라 오래된 값을 주면 티가 난다 → 짧게 잡는다.
//   섹션은 프리워밍(30분)이 계속 갱신해 주므로 stale 을 넉넉히 둬서
//   프리워밍 주기 사이에 캐시가 비는 일이 없게 한다.
const TTL_BREAKING = { fresh: 30 * 1000, stale: 5 * 60 * 1000 };
const TTL_SECTION = { fresh: 2 * 60 * 1000, stale: 60 * 60 * 1000 };
const TTL_INDICES = { fresh: 25 * 1000, stale: 5 * 60 * 1000 };
//   기준금리는 몇 달에 한 번, 환율은 초 단위로 움직인다. 티커 표시용이라
//   1분 정도 지난 값이면 충분하고, 그 뒤로는 화면에 바로 주면서 뒤에서 갱신한다.
const TTL_MARKET_EXTRA = { fresh: 60 * 1000, stale: 30 * 60 * 1000 };

// -----------------------------------------------------------------
// [속도] 응답 캐시를 재배포 너머로 잇기
//   재배포하면 프로세스가 새로 뜨면서 respCache 가 텅 빈다. 그런데 프리워밍은
//   기동 30초 뒤에야 시작하고, 접속이 있어야 서버가 깨어나므로 재배포 직후
//   첫 손님은 t=0에 도착한다. 즉 그 사람은 전체를 처음부터 만들어야 해서 19초를 기다렸다.
//
//   해결 : 기사 본문 캐시(ARTICLE_CACHE_ROW_KEY)와 같은 방식으로 완성된 응답도
//   Supabase 에 사본을 남겨두고, 기동할 때 되살린다.
//   되살린 값은 조금 오래됐지만 stale 이내면 cachedResponse 가 바로 내주고
//   갱신은 뒤에서 한다 → 첫 손님도 기다리지 않는다.
//
//   담는 대상은 프리워밍이 데우는 칸(브리핑 · 전체/물류/증시/스포츠 섹션 + 지표)뿐이다.
//   섹션 응답 하나가 80KB 남짓이라 전부 담으면 무료 티어 대역폭이 아깝다.
// -----------------------------------------------------------------
const RESP_CACHE_ROW_KEY = 'resp_cache';
// 한 번에 보낼 최대 크기. 앞에 있는 칸(브리핑 · 전체 섹션)이 더 중요하므로 순서대로 담는다.
const RESP_SUPA_MAX_BYTES = 800 * 1024;
// 저장 간격은 반드시 TTL_SECTION.stale(60분)보다 짧아야 한다.
//   사본이 stale 보다 오래되면 되살려도 '너무 낡음'으로 판정돼 아무 소용이 없다.
//   프리워밍이 30분마다 도는데 약간의 흔들림이 있어 25분으로 잡았다.
const RESP_SUPA_MIN_SAVE_GAP = 25 * 60 * 1000;
// 첫 손님을 붙잡아 둘 수 있는 한계. Supabase 가 느리거나 죽었을 때
//   무한정 기다리게 하지 않는다 (이 시간이 지나면 그냥 예전처럼 새로 만든다).
const RESP_RESTORE_MAX_WAIT = 3000;
// 이보다 낡은 사본은 되살려도 stale 초과라 쓸모가 없다 → 아예 담지도, 읽지도 않는다
const RESP_RESTORE_MAX_AGE = TTL_SECTION.stale;
let respSupaLastSaved = 0;

async function saveRespCacheToSupabase(keys, { force = false } = {}) {
  if (!SUPABASE_ENABLED || !keys || !keys.length) return;
  const now = Date.now();
  if (!force && now - respSupaLastSaved < RESP_SUPA_MIN_SAVE_GAP) return;

  const rows = [];
  let bytes = 0;
  for (const key of keys) {
    const hit = respCache.get(key);
    if (!hit || now - hit.ts >= RESP_RESTORE_MAX_AGE) continue;
    const row = [key, hit.ts, hit.value];   // ts 를 같이 담아야 되살릴 때 나이가 유지된다
    const size = JSON.stringify(row).length;
    if (bytes + size > RESP_SUPA_MAX_BYTES) continue;   // 큰 칸 하나가 뒤를 다 막지 않게 건너뛴다
    rows.push(row);
    bytes += size;
  }
  if (!rows.length) return;

  const prevSaved = respSupaLastSaved;
  respSupaLastSaved = now;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}?on_conflict=key`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{
        key: RESP_CACHE_ROW_KEY,
        value: rows,
        updated_at: new Date().toISOString(),
      }]),
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    console.log(`[캐시] 응답 ${rows.length}칸(${Math.round(bytes / 1024)}KB)을 Supabase에 저장했습니다.`);
  } catch (e) {
    console.error('[응답 캐시 Supabase 저장 실패]', e.message);   // 캐시일 뿐이라 서비스는 계속
    respSupaLastSaved = prevSaved;   // 간격 제한에 묶이지 않게 되돌린다
  }
}

async function loadRespCacheFromSupabase() {
  if (!SUPABASE_ENABLED) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}`
      + `?key=eq.${encodeURIComponent(RESP_CACHE_ROW_KEY)}&select=value`;
    const res = await fetchWithTimeout(url, { headers: supabaseHeaders() }, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    const rows = Array.isArray(body) && body.length ? body[0].value : null;
    if (!Array.isArray(rows)) return;

    const now = Date.now();
    let n = 0;
    let oldest = 0;
    for (const [key, ts, value] of rows) {
      if (!key || value === undefined || value === null) continue;
      if (respCache.has(key)) continue;             // 이미 새로 만들어진 값이 더 낫다
      if (!(now - ts < RESP_RESTORE_MAX_AGE)) continue;
      // respCacheSet 이 아니라 직접 넣는다. respCacheSet 은 ts 를 '지금'으로 새로 찍어
      //   낡은 값을 갓 만든 값처럼 보이게 만든다 → stale 판정이 어긋난다.
      respCache.set(key, { ts, value });
      oldest = Math.max(oldest, now - ts);
      n++;
    }
    while (respCache.size > RESP_CACHE_MAX) respCache.delete(respCache.keys().next().value);
    if (n) console.log(`[캐시] Supabase에서 응답 ${n}칸을 복원했습니다 (가장 낡은 것 ${Math.round(oldest / 60000)}분 전).`);
  } catch (e) {
    console.error('[응답 캐시 Supabase 복원 실패]', e.message);   // 없으면 그냥 콜드로 시작
  }
}

// 기동하자마자 시작한다. 첫 손님은 cachedResponse 에서 이 약속을 잠깐 기다린다.
//   Promise.race 로 최대 대기 시간을 못 박아, Supabase 가 느려도 손님이 묶이지 않게 한다.
respRestoreReady = (async () => {
  try {
    await Promise.race([loadRespCacheFromSupabase(), sleep(RESP_RESTORE_MAX_WAIT)]);
  } finally {
    respRestoreReady = null;   // 이후 요청은 이 검사를 그냥 지나간다
  }
})();

// /api/breaking : 프런트 '속보' 카테고리 전용
const BREAKING_SEC = { key: 'breaking', terms: ['속보'] };

function buildBreakingKey(limit, kwMap) {
  return `breaking|${limit}|${kwSig([BREAKING_SEC], kwMap)}`;
}

async function buildBreaking(limit, kwMap) {
  const { terms, exclude } = resolveSectionKw(kwMap, BREAKING_SEC);
  return { items: await fetchBreaking(limit, terms, exclude) };
}

app.get('/api/breaking', async (req, res) => {
  const limit = Math.min(Number(req.query.display) || 20, 50);
  const kwMap = parseKw(req.query.kw);
  try {
    res.json(await cachedResponse(
      buildBreakingKey(limit, kwMap),
      TTL_BREAKING,
      () => buildBreaking(limit, kwMap),
    ));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '속보를 불러오지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/news
// -----------------------------------------------------------------
// 게재기간 라벨
const HOURS_TEXT = { 1: '1시간', 3: '3시간', 12: '12시간', 24: '1일', 168: '1주일', 720: '1달', 8760: '1년' };
function hoursText(h) {
  const n = Number(h);
  return n > 0 ? (HOURS_TEXT[n] || `${n}시간`) : '전체 기간';
}

app.get('/api/news', async (req, res) => {
  const { q, display = '20', sort = 'date', hours = '24' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: '검색어(q)가 필요합니다.' });

  const terms = parseQuery(q);                       // 콤마 = OR, 공백 = AND
  const mode = terms.length > 1 ? 'or' : 'and';
  const limit = Math.min(Number(display) || 20, 50);

  // [C] 결과가 0건이면 조건을 한 단계씩 완화하는 사다리
  const reqH = Number(hours) > 0 ? Number(hours) : 0; // 0 = 모두(전체 기간)
  const steps = [{ match: 'strict', hours: String(reqH || 'all'), note: null }];
  if (reqH > 0) {
    if (reqH < 168) steps.push({ match: 'strict', hours: '168', note: '최근 1주일' });
    if (reqH < 720) steps.push({ match: 'strict', hours: '720', note: '최근 1달' });
    steps.push({ match: 'strict', hours: 'all', note: '전체 기간' });
  }
  steps.push({ match: 'loose', hours: 'all', note: '전체 기간 · 단어 일부만 일치' });

  // [다이제스트] 대형 이슈(하루 수백 건)에 묻힌 다른 기사까지 확보하려면 여러 페이지를 받아온다.
  //   검색어(AND 묶음) 수가 많으면 호출 수가 늘어나므로 페이지 수를 줄여 균형을 맞춘다.
  const digestPages = terms.length <= 1 ? 5 : terms.length <= 2 ? 3 : 2;

  try {
    let items = [];
    let used = steps[0];
    for (const s of steps) {
      items = await searchByTerms(terms, {
        display: limit,
        sort: 'date',    // 풀(pool)은 항상 최신순으로 넓게 받아오고, 최종 순서는 아래에서 다시 매긴다
        hours: s.hours,
        verify: false,   // [A] 사용자가 직접 친 키워드는 원문 검증 생략
        match: s.match,
        expand: true,    // [F] 동의어 확장
        fetchCount: 100, // [D] 최대치로 받아온 뒤 추림
        pages: digestPages,
      });
      used = s;
      if (items.length) break;
    }

    // 같은 사건을 다룬 기사는 대표 1건만 남기고 사건별로 묶는다.
    //   정확도순(sim)이면 중요도(보도량 + 최신성) 순, 최신순(date)이면 대표 기사 시간순.
    //   제목에 검색어가 든 '관련 기사'를 항상 먼저 보여주고, 본문에만 스친 기사는 뒤에서 채운다.
    const queryTokens = terms.flatMap((t) => tokensOf(t));
    const events = rankEvents(items, queryTokens);
    const cmp = sort === 'date'
      ? (a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0)
      : (a, b) => b._importance - a._importance;
    const onTopic = events.filter((e) => e._onTopic).sort(cmp);
    const offTopic = events.filter((e) => !e._onTopic).sort(cmp);
    const ordered = [...onTopic, ...offTopic];

    res.json({
      items: ordered.slice(0, limit).map(({ _importance, _cluster, _onTopic, ...rest }) => rest),
      mode,
      terms,
      relaxed: used.note,                 // 조건을 완화했다면 안내 문구용
      requested: hoursText(reqH),
      total: ordered.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/briefing : 카테고리 균형을 맞춘 오늘의 이슈 뉴스
//  - 속보 한 곳에 쏠리지 않도록 카테고리별로 따로 수집 후 라운드로빈 선발
// -----------------------------------------------------------------
const BRIEFING_SOURCES = [
  { cat: 'breaking', terms: ['속보'] },
  { cat: 'economy', terms: ['경제 금리', '환율'], domain: 'economy' },
  { cat: 'stock', terms: ['증시 코스피'], domain: 'stock' },
  { cat: 'logistics', terms: ['물류'], domain: 'logistics' },
  { cat: 'society', terms: ['정치', '사건사고'], domain: 'society' },
  { cat: 'global', terms: ['국제'], domain: 'global' },
];

const STOPWORDS = new Set(['그리고', '하지만', '이번', '위해', '통해', '대한', '관련', '기자', '뉴스', '속보', '단독', '종합']);

// 제목 토큰 비교(중복 판정)의 정확도를 높이기 위해 흔한 조사를 뒤에서 잘라낸다.
//   예: "화재에" / "화재로" → "화재" 로 같은 토큰이 되게 함
const TRAILING_JOSA = ['에서', '에게', '한테', '까지', '부터', '이라', '라는', '이나', '같이', '처럼', '보다',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '나', '뿐', '께', '째']
  .sort((a, b) => b.length - a.length);

function stripJosa(token) {
  for (const j of TRAILING_JOSA) {
    if (token.length > j.length + 1 && token.endsWith(j)) return token.slice(0, -j.length);
  }
  return token;
}

function titleTokens(title) {
  return (title || '')
    .replace(/[^\uAC00-\uD7A3A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stripJosa)
    .filter((t) => t.length >= 2);
}

// 두 기사 제목이 얼마나 겹치는지 (0~1)
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

// -----------------------------------------------------------------
// [키워드 검색] 같은 사건을 다룬 기사들을 하나로 묶고(사건 군집), 사건별 대표 1건만 남긴다.
//   목표 : "쿠팡 화재"처럼 하루에 수백 건 쏟아지는 대형 이슈가 목록을 다 차지하지 않게 하고,
//          그 기간 안에서 '여러 매체가 함께 다룬(=중요한)' 서로 다른 사건들을 골고루 보여준다.
//   방법 : 제목 토큰이 겹치는 기사들을 '단일 연결(single-linkage)'로 묶는다.
//          A~B, B~C 가 비슷하면 A~C 가 조금 달라도 같은 사건으로 본다.
//          → 표현이 제각각인 속보(“28시간째”, “소방관 탈진”, “사과”)도 한 사건으로 합쳐진다.
// -----------------------------------------------------------------
const DUP_TITLE_THRESHOLD = 0.3; // 제목 토큰 겹침이 이 이상이면 같은 사건으로 본다

// 사진/영상 캡션 제목은 대표 기사로 부적절 (내용이 빈약)
function isCaptionTitle(title) {
  return /\[?\s*(포토|영상|사진|화보|그래픽|카드뉴스|인포그래픽)\s*\]?/.test(title || '');
}

// 한 군집에서 대표 기사 하나를 고른다 : 캡션 회피 + 정보량 많은 제목 + 최신 우선
function pickRepresentative(cluster) {
  const now = Date.now();
  return cluster
    .map((it) => {
      const toks = titleTokens(it.title).length;
      const ageHr = it.datetime ? (now - new Date(it.datetime).getTime()) / 3600000 : 999;
      const score = (isCaptionTitle(it.title) ? -10 : 0) + toks + (Math.max(0, 48 - ageHr) / 48) * 3;
      return { it, score };
    })
    .sort((a, b) => b.score - a.score)[0].it;
}

// 제목 토큰 유사도로 사건 군집을 만든다 (union-find 기반 단일 연결)
function clusterByEvent(items) {
  const tok = items.map((it) => titleTokens(it.title));
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccard(tok[i], tok[j]) >= DUP_TITLE_THRESHOLD) union(i, j);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  return [...groups.values()];
}

// 사건 군집 → 대표 기사 목록 (각 대표에 중요도 _importance, 보도 규모 _cluster 부여)
//   중요도 = 보도량(여러 매체가 다룰수록 ↑, log 로 완만하게) + 최신성 + 검색어 적합도
function rankEvents(items, queryTokens = []) {
  const now = Date.now();
  const qs = queryTokens.map((t) => String(t).toLowerCase()).filter((t) => t.length >= 2);
  return clusterByEvent(items).map((cluster) => {
    const rep = pickRepresentative(cluster);
    const ageHr = rep.datetime ? (now - new Date(rep.datetime).getTime()) / 3600000 : 999;
    const recency = (Math.max(0, 72 - ageHr) / 72) * 6;           // 최근 72시간 이내면 최대 +6
    const importance = Math.log2(cluster.length + 1) * 3 + recency; // 보도량(완만) + 최신성
    // 검색어가 '제목'에 있으면 그 기사의 핵심 주제 → 관련 기사.
    //   제목엔 없고 본문에만 스친 기사는 대개 노이즈 → 후순위로 미룬다(_onTopic=false).
    const repToks = titleTokens(rep.title).map((t) => t.toLowerCase());
    const onTopic = qs.length === 0 || qs.some((q) => repToks.some((rt) => rt.includes(q) || q.includes(rt)));
    return { ...rep, _importance: importance, _cluster: cluster.length, _onTopic: onTopic };
  });
}

// -----------------------------------------------------------------
// [모든 섹션 공용] 키워드 검색과 똑같은 '사건 군집' 로직으로 같은 내용 기사를 하나로 합친다.
//   속보/물류/경제/정치·사회/글로벌/증시/스포츠(하위 섹션 포함) 어디서든
//   노출 건수 안에 같은 내용의 기사가 여러 개 뜨는 것을 막는다.
//   정렬 : sort='date' 면 최신순, 그 외(정확도순/기본)는 중요도(보도량+최신성)순.
//   (섹션 검색어는 '국제','정치'처럼 제목에 잘 안 드러나는 경우가 많아, 키워드 검색과 달리
//    제목-포함 여부로 순위를 가르지 않는다.)
// -----------------------------------------------------------------
function collapseEvents(items, sort) {
  const now = Date.now();
  const events = clusterByEvent(items).map((cluster) => {
    const rep = pickRepresentative(cluster);
    const ageHr = rep.datetime ? (now - new Date(rep.datetime).getTime()) / 3600000 : 999;
    const importance = Math.log2(cluster.length + 1) * 3 + (Math.max(0, 72 - ageHr) / 72) * 6;
    return { rep, importance };
  });
  const cmp = sort === 'date'
    ? (a, b) => new Date(b.rep.datetime || 0) - new Date(a.rep.datetime || 0)
    : (a, b) => b.importance - a.importance;
  return events.sort(cmp).map((e) => e.rep);
}

function buildBriefingKey({ limit, dateFrom, dateTo, hours }, kwMap) {
  const sig = kwSig(BRIEFING_SOURCES.map((s) => ({ key: s.cat, terms: s.terms })), kwMap);
  return `briefing|${limit}|${dateFrom || ''}|${dateTo || ''}|${hours || ''}|${sig}`;
}

async function buildBriefing({ limit, dateFrom, dateTo, hours }, kwMap) {
  // 1) 카테고리별로 따로 수집 (속보 쏠림 방지)
  //    각 카테고리는 세팅의 '포함/제외 키워드'를 그대로 반영한다.
  const perCat = await Promise.all(
    BRIEFING_SOURCES.map(async (src) => {
      const { terms, exclude } = resolveSectionKw(kwMap, { key: src.cat, terms: src.terms });
      const items = src.cat === 'breaking'
        ? await fetchBreaking(10, terms, exclude)
        : (await searchByTerms(terms, { display: 10, dateFrom, dateTo, hours, domain: src.domain, exclude })).slice(0, 10);
      return items.map((it) => ({ ...it, cat: src.cat }));
    })
  );

  // 같은 URL은 하나로 합치되, 걸린 카테고리는 모두 cats 배열에 모은다
  const byUrl = new Map();
  perCat.flat().forEach((it) => {
    if (!it.url) return;
    const prev = byUrl.get(it.url);
    if (prev) {
      if (!prev.cats.includes(it.cat)) prev.cats.push(it.cat);
    } else {
      byUrl.set(it.url, { ...it, cats: [it.cat] });
    }
  });
  const pool = [...byUrl.values()];
  if (!pool.length) return { items: [] };

  // 2) 점수 = 화제성(여러 기사에 반복 등장하는 단어) + 최신성
  const freq = new Map();
  pool.forEach((it) => {
    new Set(titleTokens(it.title)).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1));
  });

  const now = Date.now();
  pool.forEach((it) => {
    const tokens = [...new Set(titleTokens(it.title))];
    const buzz = tokens.reduce((s, t) => s + Math.max(0, (freq.get(t) || 1) - 1), 0);
    const ageHr = it.datetime ? (now - new Date(it.datetime).getTime()) / 3600000 : 48;
    it._tokens = tokens;
    it._score = buzz + (Math.max(0, 24 - ageHr) / 24) * 6;
  });

  // 3) 카테고리별 점수순 정렬
  const buckets = new Map();
  BRIEFING_SOURCES.forEach((s) => buckets.set(s.cat, []));
  pool.forEach((it) => buckets.get(it.cat).push(it));
  buckets.forEach((arr) => arr.sort((a, b) => b._score - a._score));

  // 4) 라운드로빈 선발 (카테고리 골고루) + 비슷한 기사 제외
  const picked = [];
  const cats = [...buckets.keys()];
  for (let round = 0; round < 10 && picked.length < limit; round++) {
    for (const c of cats) {
      if (picked.length >= limit) break;
      const arr = buckets.get(c);
      while (arr.length) {
        const cand = arr.shift();
        if (picked.some((p) => jaccard(p._tokens, cand._tokens) >= 0.4)) continue;
        picked.push(cand);
        break;
      }
    }
  }

  return { items: picked.map(({ _tokens, _score, ...it }) => it) };
}

app.get('/api/briefing', async (req, res) => {
  const { dateFrom, dateTo, hours, kw } = req.query;
  const opts = { limit: Math.min(Number(req.query.limit) || 5, 30), dateFrom, dateTo, hours };
  const kwMap = parseKw(kw);

  try {
    res.json(await cachedResponse(
      buildBriefingKey(opts, kwMap),
      TTL_SECTION,
      () => buildBriefing(opts, kwMap),
    ));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '브리핑을 구성하지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/all/sections : 전체 카테고리 그룹 조회
// -----------------------------------------------------------------
function buildSectionsKey(name, SECTIONS, { limit, dateFrom, dateTo, hours, sort }, kwMap) {
  return `${name}|${limit}|${dateFrom || ''}|${dateTo || ''}|${hours || ''}|${sort || ''}|${kwSig(SECTIONS, kwMap)}`;
}

async function buildAllSections({ limit, dateFrom, dateTo, hours, sort }, kwMap) {
  const sections = await Promise.all(
    ALL_SECTIONS.map(async (sec) => {
      const { terms, exclude } = resolveSectionKw(kwMap, sec);
      const items = sec.breaking
        ? await fetchBreaking(limit, terms, exclude)
        : collapseEvents(await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, domain: sec.domain, exclude }), sort).slice(0, limit);
      return { key: sec.key, label: sec.label, items };
    })
  );
  return { sections };
}

app.get('/api/all/sections', async (req, res) => {
  const { dateFrom, dateTo, perSection = '5', hours, sort, kw } = req.query;
  const kwMap = parseKw(kw);
  const opts = { limit: Math.min(Number(perSection) || 5, 30), dateFrom, dateTo, hours, sort };
  try {
    res.json(await cachedResponse(
      buildSectionsKey('all', ALL_SECTIONS, opts, kwMap),
      TTL_SECTION,
      () => buildAllSections(opts, kwMap),
    ));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// [Phase 7 C1] /api/keyword-rank : 지금 기사에 많이 나오는 낱말 Top N
//
//   네이버를 새로 부르지 않는다. '전체' 화면이 쓰는 /api/all/sections 캐시
//   (프리워밍이 30분마다 데워 두는 그 칸)를 그대로 읽어 제목의 낱말만 센다.
//   캐시가 비어 있으면 빈 목록을 주고 끝낸다 — 여기서 새로 만들면 화면 한구석의
//   장식 때문에 섹션 전체(네이버 수십 호출)를 짓게 되어 첫 손님이 느려진다.
// -----------------------------------------------------------------

// 제목에 흔해서 '화제어'로 볼 수 없는 낱말.
//   위쪽 STOPWORDS 는 기사 중복 판정용이라 짧게 잡혀 있다. 랭킹은 사람 눈에
//   그대로 노출되므로 서술어·시점어까지 한 겹 더 걸러낸다.
const RANK_STOPWORDS = new Set([
  '오늘', '내일', '어제', '올해', '작년', '지난해', '내년', '이날', '최근', '현재', '당시',
  '전날', '이후', '이전', '가운데', '대비', '기준', '전망', '예상', '계획', '추진', '발표',
  '공개', '확대', '축소', '강화', '지원', '가능', '개최', '진행', '시작', '중심', '경우',
  '상황', '문제', '이유', '방침', '검토', '결정', '요구', '주장', '지적', '강조', '설명',
  '밝혔다', '나섰다', '했다', '한다', '된다', '있다', '없다', '올랐다', '내렸다',
  '사진', '영상', '포토', '화보', '그래픽', '인터뷰', '기고', '칼럼', '전문', '일지',
  '이번주', '지난달', '이달', '내달', '상반기', '하반기',
]);

const RANK_MIN_COUNT = 2;                 // 최소 이 건수의 기사에 나와야 순위에 올린다
const RANK_SNAP_GAP = 60 * 60 * 1000;     // 등락 비교 기준(스냅샷)을 갈아 끼우는 간격
const RANK_SNAP_KEEP = 20;                // 스냅샷에 남겨 둘 순위 깊이
const RANK_SNAP_MAX = 8;                  // 키워드 설정별 스냅샷 보관 개수
const rankSnaps = new Map();              // 섹션 캐시키 -> { ts, order: [낱말...] }

// respCache 를 '읽기만' 한다. 없거나 너무 낡았으면 null (절대 새로 만들지 않는다)
function peekResponse(key, ttl) {
  const hit = respCache.get(key);
  if (!hit || Date.now() - hit.ts > ttl.stale) return null;
  return hit.value;
}

// 제목 한 줄 → [{ raw, key }]
//   key   : 조사를 뗀 형태. '삼성전자가' 와 '삼성전자는' 을 같은 낱말로 묶는 데 쓴다.
//   raw   : 화면에 보여줄 원래 표기. key 만 쓰면 조사 제거가 과하게 먹은 낱말
//           ('공매도' → '공매')이 그대로 노출되어 이상해 보인다.
//   숫자로 시작하는 토큰('15일' · '7000선')은 화제어가 아니라 수치라 버린다.
function rankTokens(title) {
  return (title || '')
    .replace(/[^가-힣A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d/.test(t) && !STOPWORDS.has(t))
    .map((raw) => ({ raw, key: stripJosa(raw) }))
    .filter((p) => p.key.length >= 2);
}

function countTitleWords(sections, kwMap) {
  // 섹션 검색어 자체('물류' · '증시' …)는 그 섹션 기사에 거의 다 들어 있다.
  //   빼지 않으면 늘 상위를 독차지한다. 화제어가 아니라 '검색 조건'이므로 제외한다.
  const skip = new Set(RANK_STOPWORDS);
  ALL_SECTIONS.forEach((sec) => {
    resolveSectionKw(kwMap, sec).terms.forEach((t) => {
      rankTokens(t).forEach((p) => skip.add(p.key));
    });
  });

  const seen = new Set();     // 같은 기사가 여러 섹션에 걸려 있어도 한 번만 센다
  const freq = new Map();     // key -> 기사 수
  const surface = new Map();  // key -> Map(원래 표기 -> 횟수)
  sections.forEach((sec) => (sec.items || []).forEach((it) => {
    const id = it.url || it.title;
    if (!id || seen.has(id)) return;
    seen.add(id);
    const once = new Map();   // 한 기사 안에서 같은 낱말이 여러 번 나와도 1건
    rankTokens(it.title).forEach((p) => {
      if (skip.has(p.key) || RANK_STOPWORDS.has(p.raw)) return;
      if (!once.has(p.key)) once.set(p.key, p.raw);
    });
    once.forEach((raw, key) => {
      freq.set(key, (freq.get(key) || 0) + 1);
      const s = surface.get(key) || new Map();
      s.set(raw, (s.get(raw) || 0) + 1);
      surface.set(key, s);
    });
  }));

  // 한 묶음의 표기들은 전부 '조사를 뗀 형태 + 조사' 꼴이다. 그중 가장 짧은 것이
  //   조사가 제일 덜 붙은 표기다('급반등에' 보다 '급반등'). 길이가 같으면 흔한 쪽.
  //   조사를 뗀 형태(key)를 그냥 쓰지 않는 이유는 과하게 잘리는 낱말이 있어서다('공매도' → '공매').
  const pickSurface = (key) => [...surface.get(key)].sort(
    (a, b) => a[0].length - b[0].length || b[1] - a[1]
  )[0][0];

  return [...freq.entries()]
    .filter(([, n]) => n >= RANK_MIN_COUNT)
    // 동점이 아주 많다. 가나다순으로 끊으면 아무 뜻 없는 낱말이 위로 오므로
    //   더 구체적인(긴) 낱말을 먼저 보여준다.
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0], 'ko'))
    .map(([key, count]) => ({ key, word: pickSurface(key), count }));
}

app.get('/api/keyword-rank', (req, res) => {
  const kwMap = parseKw(req.query.kw);
  const limit = Math.min(Number(req.query.limit) || 5, 20);

  // 기간·정렬·건수는 프리워밍과 똑같이 고정한다. 화면의 설정을 따라가면
  //   캐시 키가 갈라져 적중하지 않고, 그러면 랭킹이 영영 비어 보인다.
  const opts = { limit: WARM_PER_SECTION, hours: WARM_HOURS, sort: WARM_SORT };
  const key = buildSectionsKey('all', ALL_SECTIONS, opts, kwMap);

  const cached = peekResponse(key, TTL_SECTION);
  if (!cached) return res.json({ items: [], ready: false });

  const ranked = countTitleWords(cached.sections || [], kwMap);
  const snap = rankSnaps.get(key);

  // 등락 비교는 표기(word)가 아니라 묶음 이름(key)으로 한다.
  //   대표 표기는 기사가 바뀌면 흔들려서('삼성전자' ↔ '삼성전자가') 헛되이 NEW 가 뜬다.
  const items = ranked.slice(0, limit).map(({ key: k, ...it }, i) => {
    if (!snap) return { ...it, diff: null, isNew: false };
    const prev = snap.order.indexOf(k);
    return { ...it, diff: prev < 0 ? null : prev - i, isNew: prev < 0 };
  });

  // 등락은 '한 시간 전 순위'와 비교한다. 서버가 다시 뜨면 비교 대상이 없어져
  //   한 시간 동안은 전부 '—' 로 나온다. (메모리에만 두는 값이다)
  if (!snap || Date.now() - snap.ts > RANK_SNAP_GAP) {
    rankSnaps.set(key, {
      ts: Date.now(),
      order: ranked.slice(0, RANK_SNAP_KEEP).map((r) => r.key),
    });
    while (rankSnaps.size > RANK_SNAP_MAX) rankSnaps.delete(rankSnaps.keys().next().value);
  }

  res.json({ items, ready: true, total: ranked.length });
});

// -----------------------------------------------------------------
// 하위 카테고리 1개 조회 : /api/{base}/section/:key
//  -> 물류 / 증시 / 스포츠 / 경제 네 곳에서 함께 사용
//
//  [정리] 예전에는 하위 섹션을 통째로 주는 /api/{base}/sections 도 같이 등록했다.
//  상위 섹션 화면이 '전체보기'에서 엄선 목록(/api/{base}/digest)으로 바뀌면서
//  부르는 곳이 없어져 지웠다. 여러 섹션을 한 번에 주는 라우트는 이제
//  '전체' 화면이 쓰는 /api/all/sections 하나뿐이다.
// -----------------------------------------------------------------
async function buildOneSection(sec, { limit, dateFrom, dateTo, hours, sort }, kwMap) {
  const { terms, exclude } = resolveSectionKw(kwMap, sec);
  const items = await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, sort, domain: sec.domain, exclude });
  return { items: collapseEvents(items, sort).slice(0, limit), label: sec.label };
}

function registerSubSectionRoute(base, SECTIONS) {
  app.get(`/api/${base}/section/:key`, async (req, res) => {
    const sec = SECTIONS.find((s) => s.key === req.params.key);
    if (!sec) return res.status(404).json({ error: '존재하지 않는 카테고리입니다.' });

    const { dateFrom, dateTo, display = '20', hours, sort, kw } = req.query;
    const kwMap = parseKw(kw);
    const opts = { limit: Math.min(Number(display) || 20, 50), dateFrom, dateTo, hours, sort };
    try {
      res.json(await cachedResponse(
        buildSectionsKey(`${base}/section/${sec.key}`, [sec], opts, kwMap),
        TTL_SECTION,
        () => buildOneSection(sec, opts, kwMap),
      ));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
  });
}

registerSubSectionRoute('logistics', LOGISTICS_SECTIONS);
registerSubSectionRoute('stock', STOCK_SECTIONS);
registerSubSectionRoute('sports', SPORTS_SECTIONS);   // [추가] 스포츠 하위 섹션
registerSubSectionRoute('economy', ECONOMY_SECTIONS); // [추가] 경제 하위 섹션(거시경제/시장)

// -----------------------------------------------------------------
// [추가] /api/{base}/digest : 상위 섹션(물류 / 경제 / 증시) 화면용 '엄선' 목록
//
//   예전에는 상위 섹션을 누르면 하위 섹션 박스가 줄줄이 나오는 '전체보기'였다.
//   이제는 하위 섹션들(+ 상위 섹션 자신)의 기사를 한 통에 모아 점수를 매기고
//   화면이 요청한 건수만큼만 골라서 한 목록으로 돌려준다. 점수는 네 가지의 합이다.
//     · 정확도  : 네이버 정확도순 결과에서 몇 번째로 나왔는지 (앞일수록 검색어에 잘 맞음)
//     · 인기    : 같은 사건을 다룬 기사가 몇 건인지 (여러 매체가 다룰수록 큰 이슈)
//     · 최신성  : 얼마나 최근 기사인지
//     · 교차노출 : 하위 섹션 여러 곳에 동시에 걸렸는지
//
//   캐시를 아끼려고 '건수(display)'와 '정렬(sort)'은 캐시 키에 넣지 않는다.
//   항상 DIGEST_KEEP 건까지 순위를 매겨 캐시해 두고, 응답할 때만 자르고 늘어놓는다.
//   → 설정에서 노출 건수를 3 → 10 으로 바꿔도 네이버를 다시 부르지 않는다.
// -----------------------------------------------------------------
const DIGEST_KEEP = 30;             // 캐시에 담아 둘 최대 건수 (화면 노출 건수 최대치와 같다)
const DIGEST_POOL_PER_SECTION = 20; // 섹션마다 후보로 모아 둘 최대 건수
const DIGEST_SPREAD_PENALTY = 1.5;  // 같은 섹션에서 연달아 뽑을 때의 감점 (한 곳이 독식하지 않게)

// 상위 섹션 자신의 검색 설정.
//   스포츠는 '전체(all)' 화면에 없는 섹션이라 ALL_SECTIONS 에 정의가 없다.
//   화면 설정(DEFAULT_KEYWORDS.sports)과 같은 값으로 여기에 따로 둔다.
const DIGEST_EXTRA_PARENTS = {
  sports: { key: 'sports', label: '스포츠', terms: ['스포츠', '축구', '야구'], domain: 'sports' },
};
function digestParent(base) {
  return ALL_SECTIONS.find((s) => s.key === base) || DIGEST_EXTRA_PARENTS[base] || null;
}

// 이 상위 섹션의 기사를 어디서 모을지 : 상위 섹션 자신 + 하위 섹션 전부
//   상위 자신을 넣는 이유 : 하위 섹션 어디에도 안 걸리는 그 분야 일반 기사를 놓치지 않기 위해서다.
function digestSources(base, SECTIONS) {
  const parent = digestParent(base);
  return parent ? [parent, ...SECTIONS] : [...SECTIONS];
}

function buildDigestKey(base, sources, { dateFrom, dateTo, hours }, kwMap) {
  return `${base}/digest|${dateFrom || ''}|${dateTo || ''}|${hours || ''}|${kwSig(sources, kwMap)}`;
}

async function buildDigest(sources, { dateFrom, dateTo, hours }, kwMap) {
  // 1) 섹션별로 후보를 모은다.
  //    정렬은 화면 설정과 무관하게 항상 정확도순(sim) : '몇 번째로 나왔는지'를 점수로 써야 하고,
  //    엄선 목록은 최신순으로 긁어오면 정확도 신호가 통째로 사라진다.
  const perSec = await Promise.all(sources.map(async (sec) => {
    const { terms, exclude } = resolveSectionKw(kwMap, sec);
    const items = await searchByTerms(terms, {
      display: DIGEST_POOL_PER_SECTION, dateFrom, dateTo, hours,
      sort: 'sim', domain: sec.domain, exclude,
    });
    return items.slice(0, DIGEST_POOL_PER_SECTION)
      .map((it, i) => ({ ...it, _sec: sec.key, _rank: i }));
  }));

  // 2) 같은 기사(URL)는 하나로 합치고, 걸린 섹션은 cats 에 모은다.
  const byUrl = new Map();
  perSec.flat().forEach((it) => {
    if (!it.url) return;
    const prev = byUrl.get(it.url);
    if (!prev) { byUrl.set(it.url, { ...it, cats: [it._sec] }); return; }
    if (!prev.cats.includes(it._sec)) prev.cats.push(it._sec);
    if (it._rank < prev._rank) { prev._rank = it._rank; prev._sec = it._sec; }
  });
  const merged = [...byUrl.values()];
  if (!merged.length) return { items: [] };

  // 3) 같은 사건을 다룬 기사끼리 묶어 대표 1건만 남기고 점수를 매긴다.
  const now = Date.now();
  const events = clusterByEvent(merged).map((cluster) => {
    const rep = pickRepresentative(cluster);
    const cats = [...new Set(cluster.flatMap((c) => c.cats))];
    const best = cluster.reduce((a, b) => (b._rank < a._rank ? b : a));
    const ageHr = rep.datetime ? (now - new Date(rep.datetime).getTime()) / 3600000 : 999;
    const score =
      Math.log2(cluster.length + 1) * 3                                                     // 인기(보도량)
      + (Math.max(0, 72 - ageHr) / 72) * 6                                                  // 최신성
      + (Math.max(0, DIGEST_POOL_PER_SECTION - best._rank) / DIGEST_POOL_PER_SECTION) * 5   // 정확도
      + (cats.length - 1) * 2;                                                              // 교차 노출
    return { ...rep, cats, _home: best._sec, _score: score };
  });

  // 4) 점수순으로 뽑되, 이미 뽑힌 섹션에는 감점을 줘서 하위 섹션이 골고루 섞이게 한다.
  const rest = events;
  const used = new Map();
  const picked = [];
  while (picked.length < DIGEST_KEEP && rest.length) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const s = rest[i]._score - DIGEST_SPREAD_PENALTY * (used.get(rest[i]._home) || 0);
      if (s > bs) { bs = s; bi = i; }
    }
    const e = rest.splice(bi, 1)[0];
    used.set(e._home, (used.get(e._home) || 0) + 1);
    picked.push(e);
  }

  return { items: picked.map(({ _sec, _rank, _score, _home, ...it }) => it) };
}

function registerDigestRoute(base, SECTIONS) {
  const sources = digestSources(base, SECTIONS);
  const label = (digestParent(base) || {}).label || base;

  app.get(`/api/${base}/digest`, async (req, res) => {
    const { dateFrom, dateTo, display = '10', hours, sort, kw } = req.query;
    const kwMap = parseKw(kw);
    const opts = { dateFrom, dateTo, hours };
    const limit = Math.min(Math.max(Number(display) || 10, 1), DIGEST_KEEP);
    try {
      const data = await cachedResponse(
        buildDigestKey(base, sources, opts, kwMap),
        TTL_SECTION,
        () => buildDigest(sources, opts, kwMap),
      );
      // 캐시본은 건드리지 않는다 (slice 로 새 배열을 만들어 자른다).
      let items = (data.items || []).slice(0, limit);
      // 최신순을 골랐으면 '뽑힌 기사들' 안에서만 시간순으로 다시 늘어놓는다.
      //   무엇을 뽑을지는 정렬과 상관없이 언제나 중요도 기준이다.
      if (sort === 'date') {
        items = [...items].sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
      }
      res.json({ items, label });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
  });
}

// 하위 섹션을 가진 상위 섹션 : 눌렀을 때 '전체보기' 대신 엄선 목록을 보여준다.
const DIGEST_BASES = [
  ['logistics', LOGISTICS_SECTIONS],
  ['economy', ECONOMY_SECTIONS],
  ['stock', STOCK_SECTIONS],
  ['sports', SPORTS_SECTIONS],
];
DIGEST_BASES.forEach(([base, SECTIONS]) => registerDigestRoute(base, SECTIONS));

// -----------------------------------------------------------------
// /api/topic/:key : 단일 상위 섹션 (경제 / 정치·사회 / 글로벌 / 속보 등)
//   '전체(all)' 화면과 완전히 같은 키워드·도메인·세팅을 사용한다.
//   → 어느 화면에서 보든 같은 세팅이 적용되어 결과가 일관된다.
// -----------------------------------------------------------------
async function buildTopic(sec, { limit, dateFrom, dateTo, hours, sort }, kwMap) {
  const { terms, exclude } = resolveSectionKw(kwMap, sec);
  const items = sec.breaking
    ? await fetchBreaking(limit, terms, exclude)
    : collapseEvents(await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, sort, domain: sec.domain, exclude }), sort).slice(0, limit);
  return { items, label: sec.label };
}

app.get('/api/topic/:key', async (req, res) => {
  const sec = ALL_SECTIONS.find((s) => s.key === req.params.key);
  if (!sec) return res.status(404).json({ error: '존재하지 않는 섹션입니다.' });

  const { dateFrom, dateTo, display = '20', hours, sort, kw } = req.query;
  const kwMap = parseKw(kw);
  const opts = { limit: Math.min(Number(display) || 20, 50), dateFrom, dateTo, hours, sort };
  try {
    res.json(await cachedResponse(
      buildSectionsKey(`topic/${sec.key}`, [sec], opts, kwMap),
      sec.breaking ? TTL_BREAKING : TTL_SECTION,
      () => buildTopic(sec, opts, kwMap),
    ));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// [추가] /api/related?title=...&url=...&display=5 : 관련 기사 찾기
//   - 기사 제목에서 핵심 단어를 뽑아 검색한 뒤,
//     원본 제목과 단어가 많이 겹치는(=주제가 비슷한) 기사 순으로 정렬해
//     자기 자신을 뺀 상위 N개를 돌려준다.
// -----------------------------------------------------------------
app.get('/api/related', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const excludeUrl = String(req.query.url || '');
  const limit = Math.min(Number(req.query.display) || 5, 10);

  if (!title) return res.status(400).json({ error: '기사 제목이 필요합니다.' });

  // 제목에서 불용어를 뺀 핵심 단어(2글자 이상)를 뽑는다
  const baseTokens = titleTokens(title);
  if (!baseTokens.length) return res.json({ items: [] });

  try {
    // 대표 키워드 상위 4개를 각각(콤마=OR) 검색 → 후보를 넉넉히 모은다
    const seeds = baseTokens.slice(0, 4);
    let cand = await searchByTerms(seeds, {
      display: 40,
      sort: 'date',
      verify: false,       // 관련기사는 원문 검증 없이 빠르게
      match: 'loose',      // 단어 일부만 겹쳐도 후보로
      hours: 'all',        // 기간 제한 없이 폭넓게
      fetchCount: 40,
    });

    // 자기 자신 · 중복 · 같은 제목 제거
    const seen = new Set([excludeUrl]);
    cand = cand.filter((it) => {
      if (!it.url || seen.has(it.url)) return false;
      if (it.title === title) return false;
      seen.add(it.url);
      return true;
    });

    // 원본 제목과 단어 겹침(자카드) 점수가 높은 순 → 같으면 최신순
    cand.forEach((it) => { it._score = jaccard(baseTokens, titleTokens(it.title)); });
    cand.sort((a, b) => (b._score - a._score) || (new Date(b.datetime || 0) - new Date(a.datetime || 0)));

    // 내부 점수 필드는 빼고 반환
    const items = cand.slice(0, limit).map(({ _score, ...rest }) => rest);
    res.json({ items });
  } catch (err) {
    console.error('[related]', err.message);
    res.status(500).json({ error: '관련 기사를 불러오지 못했습니다.' });
  }
});

function pickMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return '';
  return stripHtml(tag.match(/content=["']([\s\S]*?)["']/i)?.[1] || '');
}

// -----------------------------------------------------------------
// [J] /api/deep-brief : 원문을 Gemini에게 읽혀 '주요 내용'으로 정리
//  - fetchArticleText()로 원문 본문 확보 → Gemini에 전달 → JSON으로 회신
//  - 같은 URL은 6시간 캐시 (재클릭 시 API 호출 없음 = 무료)
// -----------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// [수정] 모델을 하나로 고정하지 않는다.
//   구글이 구형 모델을 신규 API 키에 막으면서 404가 나기 때문에,
//   후보를 순서대로 시도하고 성공한 모델을 기억해서 재사용한다.
// [모델 선택] Flash-Lite 계열을 최우선으로 쓴다.
//   순서를 바꿀 땐 GEMINI_MODEL 환경변수(아래 1순위)가 이 목록보다 우선한다는 점에 주의.
//
// [2026-07-27 재조정] `/api/gemini-models?test=1&long=1` 로 Render 에서 직접 재 본 결과다.
//   실제 크기(본문 3,500자) 프롬프트 기준 :
//   - gemini-3.1-flash-lite : Render 3.1~9.5초 · 로컬 2.8~8.9초. 생각토큰 0. → 양쪽에서 되는 유일한 lite
//   - gemini-3.6-flash      : 계열이 달라 우회로로 쓸 만하지만 하루 20회 한도라 상시로는 못 쓴다
//   - gemini-3.5-flash-lite : 로컬 2.4초로 제일 빠른데 **Render 에서는 30초까지도 응답이 없다**.
//                             별칭 gemini-flash-lite-latest 도 똑같이 무응답 = 같은 백엔드다.
//                             프로덕션이 Render 이므로 1순위에서 내리고 폴백 자리에 둔다.
//   - gemini-3-flash-preview: 19.6초(생각토큰 1,328). 느려서 탈락
//   - gemini-3.5-flash      : 503(붐빔)이 계속 나서 제외
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL, // .env / Render 환경변수에 지정했다면 1순위
  'gemini-3.1-flash-lite',  // Render·로컬 양쪽에서 되고 생각토큰 0 → 최우선
  // 2순위는 일부러 '다른 계열'을 둔다. gemini-flash-lite-latest 는 lite 의 별칭이라
  //   같은 계열이 무응답·한도초과면 똑같이 실패한다. 진짜 우회가 되려면 계열이 달라야 한다.
  'gemini-3.6-flash',       // 하루 20회 한도지만 계열이 달라 우회로가 된다
  'gemini-3.1-flash-lite-preview', // 1순위와 같은 계열의 preview. 실측 중앙값이 오히려 조금 빨랐다
  'gemini-3.5-flash-lite',  // 로컬에선 제일 빠름. Render 에선 무응답이라 쿨다운으로 걸러진다
  'gemini-flash-lite-latest', // 위 모델의 자동 최신 별칭 (404로 사라졌을 때 대비)
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',  // 현재 키에서는 404(신규 키 차단). 다른 키를 대비해 남겨 둔다
  'gemini-2.5-flash',
].filter(Boolean);

let ACTIVE_MODEL = null; // 실제로 성공한 모델 이름

if (!GEMINI_API_KEY) {
  console.warn('[경고] .env 에 GEMINI_API_KEY 가 없습니다. (주요 내용 기능 비활성화)');
}

const briefCache = new Map();            // url -> { ts, brief }
const BRIEF_TTL = 1000 * 60 * 60 * 6;    // 6시간

const BRIEF_PROMPT = `너는 신문사 편집기자다. 아래 [기사 본문]만 근거로 삼아 독자가 30초 안에 이해할 수 있게 정리하라.

[절대 규칙]
- 본문에 없는 사실·숫자·날짜·이름을 절대 만들어내지 마라.
- 확실하지 않은 항목은 아예 빼라.
- 모든 문장은 한국어 존댓말('~습니다')로 끝내라.

[table 작성법]
- 항목명(key)은 기사 성격에 맞게 스스로 정하라. (예: 정의, 시점, 주체, 규모, 배경, 영향, 전망)
- 3~6개. 표로 정리할 사실이 부족하면 빈 배열 []로 둬라.

[bullets 작성법]
- 2~5개. 표에 담기 어려운 맥락이나 의미를 담아라.

[keywords 작성법]
- 이 기사를 이해하는 데 꼭 필요한 핵심 용어·개념·전문 용어를 반드시 2~3개 골라라.
- 누구나 아는 쉬운 단어는 고르지 마라. (예: 정부, 회사, 오늘 같은 단어는 제외)
- explain은 한두 문장으로, 배경지식이 없는 사람도 바로 이해할 수 있게 쉽게 풀어써라.
- 특별히 어려운 용어가 없더라도, 기사 주제·핵심 인물·기관·지역·제도 중에서 골라 반드시 2~3개를 채워라. 빈 배열([])은 절대 금지한다.

[출력 형식] 아래 JSON만 출력. 다른 말 금지.
{
  "headline": "핵심을 담은 짧은 제목",
  "lead": "핵심을 3~4문장으로 요약한 문단",
  "table": [{ "key": "항목명", "value": "내용" }],
  "bullets": ["핵심 포인트 문장"],
  "keywords": [{ "term": "용어", "explain": "쉬운 설명" }]
}`;

// 모델 하나로 실제 호출 (실패하면 status를 담은 에러를 던진다)
// [응답 없음 대비] 한 모델을 얼마나 기다려 줄지
//   2026-07-27 Render 에서 구글이 응답을 아예 안 주는 일이 생겼다(로그에 25초 abort만 반복).
//   예전에는 25초를 통째로 기다렸다가 그냥 포기했다 — 다른 모델을 시도해 볼 기회도 없었다.
//   이제는 짧게 끊고 다음 후보로 넘어간다.
const GEMINI_TIMEOUT_MS = 9000;       // 기본 상한 (성공하는 호출은 보통 2~3초라 넉넉한 편이다)
//   단, '생각(thinking)'을 하는 모델은 원래 13초쯤 걸리므로 더 넉넉히 준다.
//   여기에 없는 모델은 전부 기본값을 쓴다.
const GEMINI_SLOW_MODELS = {
  'gemini-3.6-flash': 20000,
  'gemini-flash-latest': 20000,       // 구글이 3.6-flash 로 연결해 주는 별칭
  // 1순위와 그 preview. 편차가 크다 — Render 실측 3.1 / 4.1 / 6.4 / 9.5 / 10.3 / 10.5 / 14.0 / 21.0초.
  //   기본 상한 9초를 그대로 두면 절반 이상을 코앞에서 끊고 다음 후보로 넘기게 된다.
  //   (다음 후보로 넘어가 봐야 어차피 비슷하게 느리므로, 기다리는 편이 사용자에게 낫다)
  'gemini-3.1-flash-lite': 20000,
  'gemini-3.1-flash-lite-preview': 20000,
};
function geminiTimeoutFor(model) { return GEMINI_SLOW_MODELS[model] || GEMINI_TIMEOUT_MS; }

async function callGeminiOnce(model, prompt, limitOverrideMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  // 남은 전체 시간이 모델 상한보다 짧으면 그만큼만 기다린다 (호출자가 넘겨준다)
  const limitMs = limitOverrideMs || geminiTimeoutFor(model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    if (!r.ok) {
      const bodyText = await r.text();
      const err = new Error(`Gemini ${r.status}: ${bodyText.slice(0, 200)}`);
      err.status = r.status;
      // 429일 때 구글이 알려주는 '재시도까지 대기 시간'을 뽑아둔다 (예: "retryDelay":"37s")
      const m = bodyText.match(/"retryDelay"\s*:\s*"?(\d+(?:\.\d+)?)s/i);
      if (m) err.retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
      throw err;
    }
    const data = await r.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    // 응답 없음(상한 초과)과 연결 실패는 '이 모델은 지금 못 쓴다'로 묶어서 표시한다.
    //   status 가 붙은 에러(404·429·503 등)는 구글이 대답은 해 준 것이므로 그대로 올린다.
    if (e?.status) throw e;
    const err = new Error(
      controller.signal.aborted
        ? `Gemini 응답 없음 (${Math.round(limitMs / 1000)}초 초과): ${model}`
        : `Gemini 연결 실패: ${model} (${e?.message || ''})`
    );
    err.noAnswer = true;   // ← callGeminiModels 가 '다음 후보로' 판단하는 표시
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// [추가] 구글 쪽 일시적 장애(모델 과부하 등) : 우리 잘못이 아니라 기다리거나 우회하면 되는 상태
//   503 UNAVAILABLE = "This model is currently experiencing high demand" (가장 흔함)
//   500/502/504 = 구글 내부 오류 · 게이트웨이 오류
const GEMINI_TRANSIENT_STATUS = [500, 502, 503, 504];
function isTransientGeminiError(e) { return GEMINI_TRANSIENT_STATUS.includes(e?.status); }

// -----------------------------------------------------------------
// [429 대응 ⓪] 한도가 떨어진 모델은 잠시 쉬게 하고 '다른 모델'로 넘어간다
//   구글의 무료 한도는 '모델별'이다. 예) gemini-3.6-flash 는 하루 20회.
//   한 모델이 429여도 다른 모델은 멀쩡한 경우가 많은데,
//   예전 코드는 429를 그대로 위로 던져서 30초씩 두 번 기다렸다 실패했다(실측 59초).
//   이제는 429가 나면 그 모델만 쿨다운에 넣고 곧바로 다음 후보로 넘어간다.
//   쿨다운 중인 모델은 아예 호출하지 않아 헛된 왕복을 줄인다.
// -----------------------------------------------------------------
const GEMINI_COOLDOWN_MS = 1000 * 60 * 10;   // 429 맞은 모델을 쉬게 할 기본 시간 (10분)
const GEMINI_NOANSWER_COOLDOWN_MS = 1000 * 60 * 3; // 응답이 없던 모델을 쉬게 할 시간 (3분)
//   한 번의 요청이 후보들을 훑는 데 쓸 수 있는 전체 시간.
//   이걸 안 두면 후보가 7개라 최악의 경우 20초 x 7 = 140초를 기다리게 된다.
//   남은 시간이 아래 최소치보다 적으면 더 시도하지 않고 깔끔하게 끝낸다.
//   (1순위 상한을 20초로 올렸으므로 30초로는 2순위를 제대로 못 해 본다 → 36초)
const GEMINI_TOTAL_BUDGET_MS = 36000;
//   다음 후보를 시도해 볼 가치가 있는 최소 남은 시간. 이보다 적게 남았으면 깔끔하게 포기한다
//   (2초쯤 남겨 두고 부르면 어차피 끊겨서 한도만 축낸다)
const GEMINI_MIN_TRY_MS = 6000;
const geminiCooldown = new Map();            // model -> 언제까지 쉴지(ms 시각)

function isGeminiCooling(model) {
  const until = geminiCooldown.get(model);
  if (!until) return false;
  if (Date.now() >= until) { geminiCooldown.delete(model); return false; }
  return true;
}

// 후보 목록을 돌면서 '되는 모델'을 찾아 한 번 호출한다
//  - 404(모델 없음)     → 다음 후보로
//  - 503 등 일시 장애    → 그 모델이 붐비는 것이므로 역시 다음 후보로 우회
//  - 429(한도 초과)     → 그 모델을 쿨다운에 넣고 다음 후보로 우회
//  - 응답 없음/연결 실패 → 역시 쿨다운에 넣고 다음 후보로 우회 (deadline 안에서만)
async function callGeminiModels(prompt, deadline = Date.now() + GEMINI_TOTAL_BUDGET_MS) {
  const base = ACTIVE_MODEL ? [ACTIVE_MODEL] : MODEL_CANDIDATES;
  // 쉬고 있는 모델은 건너뛴다. 다만 전부 쉬는 중이면 그냥 원래 목록대로 부딪쳐 본다
  //   (쿨다운이 실제보다 길게 잡혔을 수 있으므로 아예 못 부르는 상태는 만들지 않는다)
  const awake = base.filter((m) => !isGeminiCooling(m));
  const list = awake.length ? awake : base;
  let lastErr;
  const fails = [];   // [{ model, e }] — 모델별로 '왜 실패했는지'를 모아 둔다 (아래 원인 고르기에 쓴다)

  for (const model of list) {
    // 남은 시간이 '해 볼 가치가 있는 최소치'보다 적으면 여기서 멈춘다.
    //   (사용자를 무한정 붙잡아 두지 않기 위한 상한. 단 첫 후보는 무조건 한 번 해 본다)
    //   예전에는 '모델 상한을 통째로 확보할 수 있을 때만' 시도했는데,
    //   1순위 14초 + 2순위 20초 = 34초라 전체 상한 30초 안에서 2순위를 아예 못 해 보게 됐다.
    //   그래서 남은 시간만큼만 잘라서라도 다음 후보를 시도한다.
    const remain = deadline - Date.now();
    if (lastErr && remain < GEMINI_MIN_TRY_MS) {
      console.warn(`[Gemini] 전체 대기 상한(${GEMINI_TOTAL_BUDGET_MS / 1000}초) 도달 → 남은 후보는 다음 요청에서 시도`);
      break;
    }
    try {
      const out = await callGeminiOnce(model, prompt, Math.min(geminiTimeoutFor(model), remain));
      if (ACTIVE_MODEL !== model) console.log(`[Gemini] 사용 모델 확정: ${model}`);
      ACTIVE_MODEL = model;
      geminiCooldown.delete(model);   // 성공했으면 쿨다운 해제
      return out;
    } catch (e) {
      lastErr = e;
      fails.push({ model, e });
      if (e.status === 404) {
        console.warn(`[Gemini] ${model} 사용 불가(404) → 다음 후보 시도`);
        // 확정돼 있던 모델이 갑자기 막혔다면 확정을 풀고 전체 후보를 다시 시도
        if (ACTIVE_MODEL === model) { ACTIVE_MODEL = null; return callGeminiModels(prompt, deadline); }
        continue; // 모델이 없는 경우만 다음 후보로
      }
      if (isTransientGeminiError(e)) {
        console.warn(`[Gemini] ${model} 일시 장애(${e.status}) → 다른 모델로 우회 시도`);
        // 확정 모델이 붐비는 중 → 확정을 풀고 나머지 후보들을 훑는다
        if (ACTIVE_MODEL === model) { ACTIVE_MODEL = null; return callGeminiModels(prompt, deadline); }
        continue;
      }
      if (e.status === 429) {
        // 구글이 알려준 대기 시간이 있으면 그만큼, 없으면 10분간 이 모델을 쉬게 한다.
        //   (하루 한도가 떨어진 경우라면 어차피 다음 후보로 계속 넘어가게 된다)
        const cool = Math.max(e.retryAfterMs || 0, GEMINI_COOLDOWN_MS);
        geminiCooldown.set(model, Date.now() + cool);
        console.warn(`[Gemini] ${model} 한도 초과(429) → ${Math.round(cool / 60000)}분간 쉬고 다음 후보 시도`);
        if (ACTIVE_MODEL === model) { ACTIVE_MODEL = null; return callGeminiModels(prompt, deadline); }
        continue;
      }
      if (e.noAnswer) {
        // 구글이 대답 자체를 안 준 경우(상한 초과·연결 실패).
        //   이 모델만 잠시 쉬게 하고 다음 후보로 넘어간다.
        geminiCooldown.set(model, Date.now() + GEMINI_NOANSWER_COOLDOWN_MS);
        console.warn(`[Gemini] ${e.message} → ${GEMINI_NOANSWER_COOLDOWN_MS / 60000}분간 쉬고 다음 후보 시도`);
        if (ACTIVE_MODEL === model) { ACTIVE_MODEL = null; return callGeminiModels(prompt, deadline); }
        continue;
      }
      throw e; // 400 등은 모델을 바꿔도 소용없으므로 위로 던진다
    }
  }
  // -----------------------------------------------------------------
  // [원인 고르기] 예전에는 '마지막 에러(lastErr)' 하나만 보고 판단했다.
  //   후보 목록 맨 뒤의 2.5 계열은 현재 키에서 404라서, 진짜 원인(429·무응답)이
  //   그 404에 덮여 "쓸 수 있는 Gemini 모델을 찾지 못했습니다" 로만 표시됐다.
  //   이제는 모델별 실패 사유를 전부 모아 두고, 그중 설명이 되는 것을 골라 올린다.
  //   404(그 키에 없는 모델)는 '원인'이 아니라 '건너뛴 것'이므로 가장 뒤로 민다.
  // -----------------------------------------------------------------
  const summary = fails.map(({ model, e }) => `${model}=${geminiFailReason(e)}`).join(', ');
  if (fails.length) console.warn(`[Gemini] 후보 전부 실패 → ${summary}`);
  const pick = (fn) => fails.find(({ e }) => fn(e))?.e;
  const transient = pick(isTransientGeminiError);
  const quota = pick((e) => e?.status === 429);
  const noAnswer = pick((e) => e?.noAnswer);
  // 일시 장애·한도 초과는 그대로 위로 올려 callGemini 의 재시도·안내문 처리가 받게 한다
  if (transient) throw transient;
  if (quota) throw quota;
  if (noAnswer) {
    // 어느 모델도 대답을 안 했다 → 재시도해 봐야 같은 결과일 가능성이 크니 바로 안내한다
    const friendly = new Error('AI 서버에서 응답이 오지 않았어요. 잠시 후 다시 시도해 주세요.');
    friendly.noAnswer = true;
    throw friendly;
  }
  throw new Error(`쓸 수 있는 Gemini 모델을 찾지 못했습니다. /api/gemini-models?test=1 로 확인해 보세요. (${summary || lastErr?.message || ''})`);
}

// 실패 사유를 사람이 읽기 쉬운 한 마디로 (로그·에러 메시지에 쓴다)
function geminiFailReason(e) {
  if (e?.noAnswer) return '응답없음';
  if (e?.status === 404) return '404(키에 없는 모델)';
  if (e?.status === 429) return '429(한도초과)';
  if (e?.status) return `HTTP ${e.status}`;
  return (e?.message || '알수없음').slice(0, 60);
}

// -----------------------------------------------------------------
// [429 대응 ①] 호출 큐 : 한 번에 하나씩 + 분당 횟수 제한
//   여러 사람이 동시에 '주요 내용'을 눌러도 순서대로 내보내 분당 한도를 넘지 않게 한다.
//
//   [2026-07-27 변경] 예전에는 '무조건 6초씩 띄우기'였다.
//   그런데 구글이 실제로 막는 것은 간격이 아니라 '1분에 몇 번'이다.
//   (실측: gemini-3.5-flash-lite = GenerateRequestsPerMinutePerProjectPerModel-FreeTier = 15)
//   고정 간격 방식은 주요 내용을 본 뒤 곧바로 Insight를 누르는 흐름에서
//   두 번째 호출에 6초를 통째로 물리는 게 가장 큰 손해였다.
//   그래서 '최근 1분간 몇 번 불렀는지'만 세고, 여유가 있으면 곧바로 내보낸다.
//   → 연달아 눌러도 대기 0초. 한도에 가까워질 때만 기다린다.
// -----------------------------------------------------------------
const GEMINI_RPM_LIMIT = 13;      // 분당 허용 횟수. 실측 한도 15보다 2회 낮게 잡아 여유를 둔다
const GEMINI_WINDOW_MS = 60000;   // '분당'을 재는 창 = 60초
let geminiChain = Promise.resolve();
let geminiCallTimes = [];         // 최근 1분간의 호출 시각들

// 지금 바로 불러도 되는지 확인해서, 기다려야 하면 그 시간(ms)을 돌려준다
function geminiWaitMs() {
  const now = Date.now();
  geminiCallTimes = geminiCallTimes.filter((t) => now - t < GEMINI_WINDOW_MS);
  if (geminiCallTimes.length < GEMINI_RPM_LIMIT) return 0;   // 여유 있음 → 즉시
  // 꽉 찼다면 가장 오래된 호출이 1분 창을 벗어날 때까지만 기다리면 된다
  return GEMINI_WINDOW_MS - (now - geminiCallTimes[0]) + 50;
}

function enqueueGemini(task) {
  const run = geminiChain.then(async () => {
    // 기다린 뒤에도 다른 호출이 자리를 채웠을 수 있으니 다시 확인한다
    for (let wait = geminiWaitMs(); wait > 0; wait = geminiWaitMs()) {
      console.log(`[Gemini] 분당 한도(${GEMINI_RPM_LIMIT}회)에 도달 → ${Math.ceil(wait / 1000)}초 대기`);
      await sleep(wait);
    }
    geminiCallTimes.push(Date.now());
    return task();
  });
  geminiChain = run.then(() => {}, () => {}); // 에러가 나도 대기열이 끊기지 않게
  return run;
}

// -----------------------------------------------------------------
// [429 대응 ②③] 프론트가 실제로 부르는 함수
//   ② 429면 잠깐 기다렸다 자동 재시도(backoff). 구글이 알려준 대기 시간을 우선 사용.
//   ③ 끝내 실패하면 사용자에게 '친절한 안내 메시지'를 던진다.
// -----------------------------------------------------------------
async function callGemini(prompt) {
  const MAX_RETRY = 2; // 429 / 503 등일 때 최대 2번 더 시도
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await enqueueGemini(() => callGeminiModels(prompt));
    } catch (e) {
      // [추가] 503(모델 과부하) 등 일시 장애 : 짧게 기다렸다 다시 시도
      //   한도 초과(429)와 달리 금방 풀리는 경우가 많아 대기 시간을 더 짧게 잡는다.
      if (isTransientGeminiError(e) && attempt < MAX_RETRY) {
        const wait = Math.min(e.retryAfterMs || 2500 * Math.pow(2, attempt), 12000);
        console.warn(`[Gemini] ${e.status} 일시 장애 → ${Math.round(wait / 1000)}초 후 재시도 (${attempt + 1}/${MAX_RETRY})`);
        await sleep(wait);
        continue;
      }
      if (isTransientGeminiError(e)) {
        // 재시도까지 실패 → 개발자용 원문 대신 안내 문구로 바꿔서 올린다
        const friendly = new Error('AI 서버가 잠시 붐비고 있어요. 30초쯤 뒤에 다시 시도해 주세요.');
        friendly.status = e.status;
        throw friendly;
      }
      if (e.status === 429 && attempt < MAX_RETRY) {
        // 구글이 알려준 대기 시간이 있으면 그만큼, 없으면 8초 → 16초로 점점 늘려 기다린다
        const backoff = e.retryAfterMs || 8000 * Math.pow(2, attempt);
        const capped = Math.min(backoff, 30000); // 너무 오래는 안 기다림(최대 30초)
        console.warn(`[Gemini] 429 → ${Math.round(capped / 1000)}초 후 재시도 (${attempt + 1}/${MAX_RETRY})`);
        await sleep(capped);
        continue;
      }
      if (e.status === 429) {
        // 재시도까지 실패 → 당황하지 않도록 친절히 안내
        const friendly = new Error('무료 사용량 한도에 도달했어요. 잠시 후(약 1분 뒤) 다시 시도해 주세요.');
        friendly.status = 429;
        throw friendly;
      }
      throw e;
    }
  }
}

// -----------------------------------------------------------------
// [진단] 이 서버에서 어떤 모델이 '실제로 응답하는지' 재 본다
//   2026-07-27, 같은 코드·같은 키인데 Render 에서만 응답이 안 오는 일이 있었다.
//   내 PC 에서는 재현이 안 되므로 Render 서버가 직접 재 보는 수밖에 없다.
//   후보 모델들에게 짧은 요청을 하나씩 보내고 status·소요시간을 표로 돌려준다.
//   사용법 : https://news-insight.onrender.com/api/gemini-models?test=1
//           특정 모델만 : ...?test=1&models=gemini-3.5-flash-lite,gemini-3.1-flash-lite
// -----------------------------------------------------------------
// 후보 목록에는 없지만 '대안이 될 수 있나' 확인해 볼 만한 모델들
const GEMINI_PROBE_EXTRA = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
];
const PROBE_TIMEOUT_MS = 15000;   // 실제 호출 상한(9초)보다 길게 줘서 '느린 것'과 '아예 안 오는 것'을 구분한다
const PROBE_LONG_TIMEOUT_MS = 30000; // long=1(실제 크기 프롬프트)일 때. '생각'하는 모델은 원래 오래 걸린다
const PROBE_CONCURRENCY = 3;      // 한꺼번에 다 쏘면 서로 영향을 줄 수 있어 3개씩만
let probeRunning = false;         // 동시에 두 번 돌리지 않게 (한도를 헛되이 쓰지 않으려고)

// [long=1] 실제 '주요 내용' 호출과 비슷한 크기(본문 3,500자)의 프롬프트.
//   짧은 인사만으로 재면 '생각'하는 모델의 진짜 비용이 안 드러나서, 1순위를 고를 근거가 못 된다.
function probeLongPrompt() {
  const body = ('정부는 이날 물류 인프라 확충 계획을 발표했다. 관계 부처는 내년 상반기까지 '
    + '수도권 물류센터 세 곳을 추가로 짓고, 항만 배후단지 임대료를 한시적으로 낮추기로 했다. '
    + '업계는 운송비 부담이 줄어들 것으로 보면서도 인력 수급 문제가 남아 있다고 지적했다. ')
    .repeat(20).slice(0, 3500);
  return `${BRIEF_PROMPT}\n\n[기사 제목] 정부, 물류 인프라 확충 계획 발표\n[기사 본문]\n${body}`;
}

// 모델 하나에 요청을 보내 본다. 실제 호출과 같은 형태(JSON 응답 요구)로 보낸다.
async function probeGeminiModel(model, long = false, ver = 'v1beta') {
  // ver 은 API 버전(v1beta / v1). Render 에서 특정 모델만 응답이 없을 때
  //   '경로 문제인지 모델 문제인지' 가르려고 바꿔 볼 수 있게 열어 뒀다.
  const url = `https://generativelanguage.googleapis.com/${ver}/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const limitMs = long ? PROBE_LONG_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: long ? probeLongPrompt() : '{"ok":true} 만 출력해라.' }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    const bodyText = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) return { model, ok: false, result: `HTTP ${r.status}`, ms, detail: bodyText.slice(0, 160) };
    let sample = '';
    let usage = null;
    try {
      const parsed = JSON.parse(bodyText);
      sample = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const u = parsed?.usageMetadata || {};
      // thoughts = '생각(thinking)'에 쓴 토큰. 이게 크면 그 모델은 요약 작업에 과한 추론을 하고 있다는 뜻이다
      usage = { prompt: u.promptTokenCount, out: u.candidatesTokenCount, thoughts: u.thoughtsTokenCount || 0 };
    } catch { /* 무시 */ }
    return { model, ok: true, result: 'OK', ms, usage, detail: sample.slice(0, 60) };
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      model, ok: false, ms,
      result: controller.signal.aborted ? `응답없음(${limitMs / 1000}초 초과)` : '연결실패',
      detail: (e?.message || '').slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

// [추가] 내 API 키로 실제 쓸 수 있는 모델 목록 확인
//   브라우저에서 http://localhost:3000/api/gemini-models 접속
app.get('/api/gemini-models', async (req, res) => {
  if (!GEMINI_API_KEY) return res.json({ error: '.env 에 GEMINI_API_KEY 가 없습니다.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const data = await r.json();
    const usable = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));

    if (!req.query.test) return res.json({ active: ACTIVE_MODEL, candidates: MODEL_CANDIDATES, usable });

    if (probeRunning) return res.status(429).json({ error: '진단이 이미 돌고 있습니다. 잠시 뒤 다시 열어 주세요.' });
    probeRunning = true;
    const t0 = Date.now();
    try {
      const asked = String(req.query.models || '').split(',').map((s) => s.trim()).filter(Boolean);
      const targets = [...new Set(asked.length ? asked : [...MODEL_CANDIDATES, ...GEMINI_PROBE_EXTRA])];
      const long = !!req.query.long;   // long=1 이면 실제 크기(본문 3,500자) 프롬프트로 잰다
      const ver = req.query.ver === 'v1' ? 'v1' : 'v1beta';   // ver=v1 로 다른 API 경로도 시험해 본다
      const results = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, async () => {
          while (next < targets.length) {
            const model = targets[next++];
            const one = await probeGeminiModel(model, long, ver);
            results.push({ ...one, inAccount: usable.includes(model) });
          }
        })
      );
      // 되는 모델을 먼저, 그 안에서는 빠른 순으로
      results.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
      const okList = results.filter((x) => x.ok).map((x) => `${x.model} ${x.ms}ms`);
      console.log(`[Gemini 진단] ${results.length}개 시도, 성공 ${okList.length}개 → ${okList.join(', ') || '없음'}`);
      res.json({
        note: `이 서버에서 각 모델에 ${long ? '실제 크기(본문 3,500자)' : '짧은'} 요청을 보내 본 결과입니다. ok:true 중 ms가 작은 것이 1순위 후보입니다.`,
        mode: `${long ? 'long(실제 크기 프롬프트)' : 'short(짧은 인사)'} · ${ver}`,
        active: ACTIVE_MODEL,
        candidates: MODEL_CANDIDATES,
        tookMs: Date.now() - t0,
        results,
      });
    } finally {
      probeRunning = false;
    }
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/deep-brief', async (req, res) => {
  const url = req.query.url;
  const title = String(req.query.title || '').slice(0, 200);

  if (!GEMINI_API_KEY) return res.json({ error: '.env 에 GEMINI_API_KEY 가 없습니다.' });
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url이 필요합니다.' });

  const cached = briefCache.get(url);
  if (cached && Date.now() - cached.ts < BRIEF_TTL) return res.json(cached.brief);

  try {
    // [수정] 언론사 원문 → 네이버 뉴스 → 네이버 모바일 순으로 자동 재시도
    let body = await fetchArticleTextSmart(url, req.query.naver, 300);
    let partial = false;

    // 그래도 짧으면, 최소한 요약문(네이버 제공 설명)이라도 근거로 사용한다
    if (!body || body.length < 200) {
      const desc = String(req.query.desc || '').slice(0, 1200).trim();
      if (desc.length >= 60) {
        body = desc;
        partial = true;   // 본문이 아니라 요약문 기반임을 표시
      }
    }

    if (!body || body.length < 60) {
      return res.json({ error: '원문 본문을 읽지 못했습니다. 해당 언론사가 자동 수집을 막았을 수 있습니다. (원문 보기로 확인해 주세요)' });
    }

    // [토큰 절약] 본문을 3500자로 줄인다. 앞부분에 핵심이 몰려 있어
    //   품질은 크게 안 떨어지면서 토큰(=사용량)을 아낄 수 있다.
    const bodyForAI = body.slice(0, 3500);

    const raw = await callGemini(`${BRIEF_PROMPT}\n\n[기사 제목]\n${title}\n\n[기사 본문]\n${bodyForAI}`);

    let brief;
    try {
      brief = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.json({ error: 'AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.' });
    }

    brief.model = ACTIVE_MODEL || 'Gemini';
    if (partial) brief.partial = true;   // 요약문만으로 정리한 경우
    briefCache.set(url, { ts: Date.now(), brief });
    res.json(brief);
  } catch (err) {
    console.error('[deep-brief]', err.message);
    res.json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// [K] /api/insight : 원문을 Gemini에게 읽혀 '두 가지 관점의 인사이트'로 정리
//  - deep-brief와 같은 구조(본문 확보 → Gemini → JSON). 캐시/호출 큐도 재사용.
//  - ① 물류 관점 Insight  ② Stock Market Insight
// -----------------------------------------------------------------
const insightCache = new Map();          // url -> { ts, insight }
const INSIGHT_TTL = 1000 * 60 * 60 * 6;  // 6시간 (deep-brief와 동일)

// 응답 형식 버전. 캐시가 6시간이라 프롬프트 형식을 바꾸면 옛 형식이 섞여 나온다.
// 키 앞에 붙여 두면 형식을 바꿀 때 이 값만 올려서 옛 사본을 통째로 무시할 수 있다.
const INSIGHT_FMT = 'v2';
const insightKey = (url) => `${INSIGHT_FMT}|${url}`;

const INSIGHT_PROMPT = `너는 종합물류기업의 신사업 전략가이자 증시를 읽는 애널리스트다. 아래 [기사 본문]만 근거로, 이 기사가 갖는 의미를 두 가지 관점으로 짚어라.

[절대 규칙]
- 본문에 없는 구체적 사실·숫자·날짜·이름을 지어내지 마라.
- 다만 본문 사실에서 자연스럽게 이어지는 해석·전망·아이디어는 '인사이트'로 제시해도 된다. 오히려 창의성을 최대한 발휘하라.
- 해석·추정·제안인 문장은 '~로 보입니다', '~할 가능성이 있습니다', '~를 노려볼 만합니다' 처럼 추정·제안 표현으로 써라.
- 문체는 간결하게, 핵심만. 군더더기·수식어를 빼고 한 문장에 하나의 인사이트만 담아라.
- verdict(핵심 판단) 문장은 한국어 존댓말('~습니다')로 끝내라.
- 특정 물류회사의 실명(롯데글로벌로지스, CJ대한통운 등)을 절대 쓰지 마라. 주체는 항상 '물류사'로만 표현하라. (본문에 회사명이 나와도 인사이트 문장에서는 '물류사'로 쓴다)
- opportunity(기회)·risk(리스크)는 개조식 종결어미로 끝내라. (예: '~습니다'→'~함', '~있습니다'→'~있음', '~보입니다'→'~보임', '~됩니다'→'~됨'). '~다' 평서형이 아니라 반드시 명사형 종결('~함/~음/~임')로 끝내라.

[① 물류사 사업기회 관점 (logistics)]
- 이 기사에서 종합물류사가 잡을 수 있는 '사업기회'를 발굴하라.
- 택배·풀필먼트·3PL·국제운송(포워딩)·창고·콜드체인·라스트마일 등 종합물류사의 사업영역과 기사를 연결하라.
- 새로 열리는 수요, 노려볼 화주·산업, 제휴·인수 대상, 신규 서비스 아이디어, 선점해야 할 물류 트렌드 중 이 기사에 가장 어울리는 것을 창의적으로 짚어라.
- 기사가 물류와 무관해 보여도, 파급 경로를 상상해 물류사의 기회로 연결하라.

[② 주식시장 관점 (stock)]
- 이 기사의 내용이 주식시장에 어떤 영향을 줄지 짚어라.
- 수혜/피해가 예상되는 업종·테마(예: 반도체, 2차전지, 조선, 유통, 항공 등)와 그 이유를 연결하라.
- 단기(수급·투자심리)와 중장기(실적·업황) 영향을 구분해서 보면 좋다.
- verdict·opportunity·risk·indicators 에서는 상장사 실명을 쓰지 말고 업종·테마 단위로만 표현하라. (개별 회사는 아래 stocks에만 적는다)
- 기사가 증시와 무관해 보여도, 파급 경로를 상상해 시장 영향으로 연결하라.
- 모든 문장은 단정하지 말고 '~로 보임', '~할 가능성이 있음' 같은 추정 표현으로 써라.

[②-1 관련 주요 종목 (stocks)]
- 이 이슈와 연결되는 '주요 종목'을 3~5개 골라라. 이것은 위 [절대 규칙]의 '이름을 지어내지 마라'의 유일한 예외로, 본문에 없는 회사라도 네가 아는 실제 상장사를 적어라.
- 실제로 존재하는, 널리 알려진 상장사만 적어라. 확신이 없는 회사는 아예 빼라. 개수를 채우려고 애매한 회사를 넣지 마라.
- 종목코드·주가·목표주가·수익률 같은 숫자는 절대 쓰지 마라. (네가 실시간 시세를 모르기 때문이다)
- 한국 상장사를 우선하되, 이슈가 해외 중심이면 미국 등 해외 상장사를 섞어도 된다.
- 각 종목마다 이 기사와의 연결고리를 한 줄로 적고, 수혜인지 부담인지 tag 로 표시하라.
  - tag 는 '수혜' / '부담' / '중립' 중 하나만 쓴다.
- reason 은 개조식('~함/~음/~임')으로 끝내라.

[각 관점을 채우는 네 칸]
두 관점(logistics, stock) 모두 아래 네 칸을 빠짐없이 채워라. 빈 칸을 남기지 마라.
- verdict (핵심 판단) : 그 관점에서 이 기사를 어떻게 읽어야 하는지를 2~3문장으로. 네 칸 중 가장 중요하다.
  단순 요약이 아니라 '그래서 무엇을 뜻하는가'를 써라.
- opportunity (기회) : 이 이슈에서 잡을 수 있는 것. 한 줄(공백 포함 60자 이내), 개조식.
- risk (리스크) : 이 이슈에서 조심해야 할 것. 한 줄(공백 포함 60자 이내), 개조식.
- indicators (주목할 지표) : 앞으로 지켜볼 지표·이벤트의 '이름'만 3~4개.
  각 12자 이내의 짧은 명사구로 쓰고, 문장·숫자·전망치를 넣지 마라.
  (좋은 예: "영남권 물동량", "경쟁사 착공 공시", "SCFI 주간 추이" / 나쁜 예: "물동량이 20% 늘어날 것으로 보임")

[출력 형식] 아래 JSON만 출력. 다른 말 금지.
{
  "logistics": { "verdict": "물류사 관점의 핵심 판단 2~3문장", "opportunity": "잡을 수 있는 것 한 줄", "risk": "조심할 것 한 줄",
                 "indicators": ["지표명", "지표명", "지표명"] },
  "stock":     { "verdict": "주식시장 관점의 핵심 판단 2~3문장", "opportunity": "잡을 수 있는 것 한 줄", "risk": "조심할 것 한 줄",
                 "indicators": ["지표명", "지표명", "지표명"],
                 "stocks": [{ "name": "종목명", "sector": "업종/테마", "tag": "수혜", "reason": "기사와의 연결고리 한 줄" }] }
}`;

app.get('/api/insight', async (req, res) => {
  const url = req.query.url;
  const title = String(req.query.title || '').slice(0, 200);

  if (!GEMINI_API_KEY) return res.json({ error: '.env 에 GEMINI_API_KEY 가 없습니다.' });
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url이 필요합니다.' });

  const cached = insightCache.get(insightKey(url));
  if (cached && Date.now() - cached.ts < INSIGHT_TTL) return res.json(cached.insight);

  try {
    // deep-brief와 동일하게: 언론사 원문 → 네이버 뉴스 → 네이버 모바일 순으로 자동 재시도
    let body = await fetchArticleTextSmart(url, req.query.naver, 300);
    let partial = false;

    // 본문이 짧으면 네이버 요약문이라도 근거로 사용
    if (!body || body.length < 200) {
      const desc = String(req.query.desc || '').slice(0, 1200).trim();
      if (desc.length >= 60) {
        body = desc;
        partial = true;
      }
    }

    if (!body || body.length < 60) {
      return res.json({ error: '원문 본문을 읽지 못했습니다. 해당 언론사가 자동 수집을 막았을 수 있습니다. (원문 보기로 확인해 주세요)' });
    }

    const bodyForAI = body.slice(0, 3500);   // 토큰 절약 (deep-brief와 동일)

    const raw = await callGemini(`${INSIGHT_PROMPT}\n\n[기사 제목]\n${title}\n\n[기사 본문]\n${bodyForAI}`);

    let insight;
    try {
      insight = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.json({ error: 'AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.' });
    }

    insight.model = ACTIVE_MODEL || 'Gemini';
    if (partial) insight.partial = true;
    insightCache.set(insightKey(url), { ts: Date.now(), insight });
    res.json(insight);
  } catch (err) {
    console.error('[insight]', err.message);
    res.json({ error: err.message });
  }
});

// -----------------------------------------------------------------
// /api/indices : KOSPI / KOSDAQ / NASDAQ / S&P 500 / DOW JONES
// -----------------------------------------------------------------
// key : 화면(지수 카드·차트 팝업)이 지수를 구분할 때 쓰는 고정 이름.
//   name 은 표시용이라 바뀔 수 있으므로 화면이 이름으로 짝을 맞추지 않게 한다.
const INDEX_TARGETS = [
  { key: 'kospi', codes: ['KOSPI'], name: 'KOSPI', world: false },
  { key: 'kosdaq', codes: ['KOSDAQ'], name: 'KOSDAQ', world: false },
  { key: 'nasdaq', codes: ['.IXIC'], name: 'NASDAQ', world: true },
  { key: 'sp500', codes: ['.INX', '.SPX', 'SPI@SPX'], name: 'S&P 500', world: true },
  { key: 'dow', codes: ['.DJI'], name: 'DOW JONES', world: true },
];

function toNum(v) {
  if (v === null || v === undefined) return NaN;
  return Number(String(v).replace(/,/g, ''));
}

function indexUrls({ codes, world }) {
  const urls = [];
  codes.forEach((code) => {
    const c = encodeURIComponent(code);
    if (world) {
      urls.push(`https://api.stock.naver.com/index/${c}/basic`);
      urls.push(`https://m.stock.naver.com/api/index/${c}/basic`);
    } else {
      urls.push(`https://m.stock.naver.com/api/index/${c}/basic`);
    }
  });
  return urls;
}

async function fetchOneIndex(target) {
  const { codes, name, key } = target;
  let lastErr;

  for (const url of indexUrls(target)) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://m.stock.naver.com/',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const price = toNum(data.closePrice ?? data.nowVal ?? data.now_val);
      if (Number.isNaN(price)) throw new Error('응답 형식 해석 불가');

      const change = Math.abs(toNum(data.compareToPreviousClosePrice ?? data.changeVal ?? data.change_val) || 0);
      const percent = Math.abs(toNum(data.fluctuationsRatio ?? data.changeRate ?? data.change_rate) || 0);

      const dirCode = data?.compareToPreviousPrice?.code;
      const isDown = dirCode === '5' || dirCode === '4';

      return {
        key,
        name,
        price,
        change: isDown ? -change : change,
        changePercent: isDown ? -percent : percent,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`지수 조회 실패 (${codes.join('/')}): ${lastErr?.message || 'unknown'}`);
}

// 화면의 지수 티커는 30초마다 이 API를 부른다. 캐시가 없으면 탭을 하나 열어둘 때마다
// 시간당 600회 넘게 네이버 증권에 접속하게 되고, 그 부하가 기사 로딩 속도를 갉아먹는다.
// 서버에서 한 번 받아 여러 탭이 나눠 쓰게 한다.
async function buildIndices() {
  const settled = await Promise.allSettled(INDEX_TARGETS.map(fetchOneIndex));

  const items = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') items.push(result.value);
    else console.error(`[지수 조회 실패] ${INDEX_TARGETS[i].name}:`, result.reason?.message || result.reason);
  });

  // 전부 실패하면 캐시에 남기지 않는다(빈 값이 25초 동안 굳어버리는 것을 막는다)
  if (items.length === 0) throw new Error('증시 지수 정보를 가져오지 못했습니다.');
  return { items };
}

app.get('/api/indices', async (req, res) => {
  try {
    res.json(await cachedResponse('indices', TTL_INDICES, buildIndices));
  } catch (err) {
    res.status(502).json({ error: '증시 지수 정보를 가져오지 못했습니다.', items: [] });
  }
});

// -----------------------------------------------------------------
// /api/index-chart : 증시 지수의 기간별 추이 (지수 카드를 누르면 열리는 차트 팝업용)
//  - 1일은 5분봉, 1주일은 30분봉, 그 위로는 일봉(3년만 주봉)이다.
//  - 1순위는 야후 파이낸스. 지수 5개 × 모든 기간을 같은 형식으로 주고
//    5분봉까지 있어서 이 경로 하나로 화면이 다 채워진다.
//  - 야후가 막히면 네이버로 넘어간다. 다만 네이버는
//      · 국내(코스피/코스닥) : 분봉 + 임의 기간 일/주봉이 모두 된다.
//      · 해외(나스닥/S&P/다우) : 분봉이 빈 배열로 오고, 한 번에 110개까지만 준다.
//    그래서 폴백은 되는 것만 채우고, 해외 '1일'처럼 안 되는 조합은 오류로 돌려준다.
//  - 응답 형식 : { key, name, range, points: [{ t(초), value }], prevClose, gmtoffset, source }
//    t 는 UTC 초, gmtoffset 은 그 거래소의 시차(초)다. 화면은 이 둘을 더해
//    '거래소 현지 시각'으로 축을 그린다 → 보는 사람의 시간대와 상관없이 같은 그림이 된다.
// -----------------------------------------------------------------
const INDEX_CHART_TARGETS = {
  kospi:  { name: 'KOSPI',     yahoo: '^KS11', world: false, naverCode: 'KOSPI' },
  kosdaq: { name: 'KOSDAQ',    yahoo: '^KQ11', world: false, naverCode: 'KOSDAQ' },
  sp500:  { name: 'S&P 500',   yahoo: '^GSPC', world: true,  naverCode: '.INX' },
  nasdaq: { name: 'NASDAQ',    yahoo: '^IXIC', world: true,  naverCode: '.IXIC' },
  dow:    { name: 'DOW JONES', yahoo: '^DJI',  world: true,  naverCode: '.DJI' },
  // 환율은 지수가 아니지만 같은 화면·같은 응답 형식으로 보여준다.
  //   야후는 24시간 시세라 시차를 런던(BST)으로 준다 → 한국 시각으로 읽도록 gmtoffset 을 고정한다.
  usdkrw: { name: '원/달러 환율', yahoo: 'KRW=X', world: true, fx: true,
            naverCode: 'FX_USDKRW', gmtoffset: 9 * 3600 },
};

// days = 화면에 보여줄 기간(일). 폴백에서 '어디서 잘라낼지' 기준으로도 쓴다.
const INDEX_CHART_RANGES = {
  '1d': { label: '1일',   yRange: '1d',  yInterval: '5m',  days: 1 },
  '1w': { label: '1주일', yRange: '5d',  yInterval: '30m', days: 7 },
  '1m': { label: '1개월', yRange: '1mo', yInterval: '1d',  days: 31 },
  '3m': { label: '3개월', yRange: '3mo', yInterval: '1d',  days: 92 },
  '6m': { label: '6개월', yRange: '6mo', yInterval: '1d',  days: 183 },
  '1y': { label: '1년',   yRange: '1y',  yInterval: '1d',  days: 365 },
  '3y': { label: '3년',   yRange: '3y',  yInterval: '1wk', days: 1095 },
};

// UA_BROWSER 는 이 아래(SCFI 절)에서 선언되므로 파일을 읽는 시점에는 아직 값이 없다.
//   실제로 부를 때 꺼내도록 함수로 둔다.
function naverStockHeaders() {
  return {
    'User-Agent': UA_BROWSER,
    Accept: 'application/json',
    Referer: 'https://m.stock.naver.com/',
  };
}

// [1순위] 야후 파이낸스 차트 API. 키·쿠키가 필요 없다.
async function fetchIndexChartFromYahoo(target, rangeKey) {
  const range = INDEX_CHART_RANGES[rangeKey];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target.yahoo)}`
    + `?range=${range.yRange}&interval=${range.yInterval}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': UA_BROWSER, Accept: 'application/json' },
  }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  const stamps = r?.timestamp;
  const closes = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(stamps) || !Array.isArray(closes)) throw new Error('야후 응답 형식 해석 불가');

  // 휴장·거래정지 구간은 close 가 null 로 온다 → 선이 끊기지 않게 빼고 잇는다.
  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    if (Number.isFinite(stamps[i]) && Number.isFinite(closes[i])) {
      points.push({ t: stamps[i], value: closes[i] });
    }
  }
  if (points.length < 2) throw new Error('야후 응답에 값이 부족함');

  return {
    points,
    prevClose: Number.isFinite(r.meta?.chartPreviousClose) ? r.meta.chartPreviousClose : null,
    // 환율처럼 시차를 따로 정해 둔 대상은 그 값을 쓴다 (야후가 주는 거래소 시차를 무시)
    gmtoffset: Number.isFinite(target.gmtoffset) ? target.gmtoffset
      : Number.isFinite(r.meta?.gmtoffset) ? r.meta.gmtoffset : 0,
    source: 'Yahoo Finance',
  };
}

// 'YYYYMMDDHHmmss'(한국 시각) → UTC 초
function kstStampToEpoch(s) {
  const ms = Date.parse(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`
  );
  return Number.isNaN(ms) ? NaN : Math.round(ms / 1000);
}

// 'YYYYMMDD' → 그날 정오(UTC) 초.
//   일봉은 날짜만 쓰므로 시각은 아무 값이나 되지만, 자정으로 잡으면 시차 때문에
//   화면에서 하루 밀려 보일 수 있어 정오로 둔다.
function dayStampToEpoch(s) {
  const ms = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), 12);
  return Number.isNaN(ms) ? NaN : Math.round(ms / 1000);
}

function trimToRange(points, days) {
  const from = Date.now() / 1000 - days * 86400;
  const kept = points.filter((p) => p.t >= from);
  return kept.length >= 2 ? kept : points.slice(-2);   // 점이 1개면 선이 안 그려진다
}

// [2순위 · 국내] 코스피 / 코스닥
//   · 1일 : 네이버 증권 분봉(1분)을 받아 5분 간격으로 솎는다. (오늘치만 온다)
//   · 그 밖 : 임의 기간을 받을 수 있는 siseJson 으로 일/주봉을 받는다.
//     1주일도 여기로 보낸다. 분봉으로는 오늘 하루밖에 못 채우기 때문이다.
async function fetchIndexChartFromNaverDomestic(target, rangeKey) {
  const range = INDEX_CHART_RANGES[rangeKey];

  if (rangeKey === '1d') {
    // 정규장이 390분이라 400개면 오늘치가 모두 들어온다.
    const url = `https://api.stock.naver.com/chart/domestic/index/${encodeURIComponent(target.naverCode)}/minute?count=400`;
    const res = await fetchWithTimeout(url, { headers: naverStockHeaders() }, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('네이버 분봉 응답이 비어 있음');

    const points = [];
    rows.forEach((row) => {
      const stamp = String(row.localDateTime || '');
      const value = toNum(row.currentPrice ?? row.closePrice);
      if (stamp.length !== 14 || !Number.isFinite(value)) return;
      if (Number(stamp.slice(10, 12)) % 5 !== 0) return;   // 5분봉만 남긴다
      const t = kstStampToEpoch(stamp);
      if (Number.isFinite(t)) points.push({ t, value });
    });
    if (points.length < 2) throw new Error('네이버 분봉에 값이 부족함');
    return { points, prevClose: null, gmtoffset: 9 * 3600, source: '네이버 증권' };
  }

  const end = new Date();
  // 휴장일이 있어 요청 기간보다 점이 적게 온다 → 넉넉히(1.6배) 받아서 뒤에서 자른다.
  const start = new Date(end.getTime() - Math.round(range.days * 1.6) * 86400000);
  const timeframe = range.days > 730 ? 'week' : 'day';
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(target.naverCode)}`
    + `&requestType=1&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=${timeframe}`;
  const res = await fetchWithTimeout(url, { headers: naverStockHeaders() }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  // 응답이 정식 JSON이 아니라(머리글 행이 작은따옴표) 값만 골라 읽는다.
  //   ["20250102", 시가, 고가, 저가, 종가, 거래량, 외국인소진율]
  const points = [];
  const re = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = dayStampToEpoch(m[1]);
    const value = Number(m[5]);   // 종가
    if (Number.isFinite(t) && Number.isFinite(value)) points.push({ t, value });
  }
  if (points.length < 2) throw new Error('네이버 일봉에 값이 부족함');
  return {
    points: trimToRange(points, range.days),
    prevClose: null,
    gmtoffset: 9 * 3600,
    source: '네이버 증권',
  };
}

// [2순위 · 해외] 나스닥 / S&P 500 / 다우
//   분봉은 빈 배열로 오고, 일·주·월봉은 한 번에 110개까지만 준다.
//   → 기간에 맞춰 봉 종류를 바꿔 110개 안에 들어오게 한다.
async function fetchIndexChartFromNaverForeign(target, rangeKey) {
  const range = INDEX_CHART_RANGES[rangeKey];
  // 분봉이 없으므로 '1일'만 포기한다. 1주일은 일봉 5개로 대신 그린다.
  if (rangeKey === '1d') throw new Error('해외 지수는 분봉 대체 경로가 없음');

  const periodType = range.days <= 183 ? 'dayCandle' : range.days <= 730 ? 'weekCandle' : 'monthCandle';
  const url = `https://api.stock.naver.com/chart/foreign/index/${encodeURIComponent(target.naverCode)}?periodType=${periodType}`;
  const res = await fetchWithTimeout(url, { headers: naverStockHeaders() }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const rows = Array.isArray(data?.priceInfos) ? data.priceInfos : [];
  const points = [];
  rows.forEach((row) => {
    const stamp = String(row.localDate || '');
    const value = toNum(row.closePrice);
    if (stamp.length !== 8 || !Number.isFinite(value)) return;
    const t = dayStampToEpoch(stamp);
    if (Number.isFinite(t)) points.push({ t, value });
  });
  if (points.length < 2) throw new Error('네이버 해외 지수에 값이 부족함');
  points.sort((a, b) => a.t - b.t);
  return {
    points: trimToRange(points, range.days),
    prevClose: null,
    gmtoffset: 0,
    source: '네이버 증권',
  };
}

// [2순위 · 환율] 원/달러
//   네이버 환율에는 분봉 경로가 없고, 일별 시세를 한 페이지에 10일치씩만 준다.
//   → 필요한 만큼 페이지를 나눠 받되 상한을 둔다. 그보다 긴 기간은 야후가 살아나야 그려진다.
const FX_NAVER_PAGE_ROWS = 10;
const FX_NAVER_MAX_PAGES = 10;

async function fetchIndexChartFromNaverFx(target, rangeKey) {
  const range = INDEX_CHART_RANGES[rangeKey];
  if (rangeKey === '1d') throw new Error('환율은 분봉 대체 경로가 없음');

  // 주말·공휴일에는 시세가 없어 달력 날짜보다 행이 적다 → 영업일 비율(5/7)로 필요한 장수를 잡는다.
  const pages = Math.ceil((range.days * 5) / 7 / FX_NAVER_PAGE_ROWS) + 1;
  if (pages > FX_NAVER_MAX_PAGES) throw new Error('네이버 환율로는 이 기간을 채울 수 없음');

  const lists = await Promise.all(
    Array.from({ length: pages }, async (_, i) => {
      const url = `https://api.stock.naver.com/marketindex/exchange/${encodeURIComponent(target.naverCode)}`
        + `/prices?page=${i + 1}`;
      const res = await fetchWithTimeout(url, { headers: naverStockHeaders() }, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    })
  );

  // 페이지를 동시에 받는 사이 오늘 시세가 갱신되면 같은 날짜가 두 번 들어올 수 있다 → 날짜별로 하나만 남긴다.
  const byDay = new Map();
  lists.flat().forEach((row) => {
    const day = String(row?.localTradedAt || '').replace(/-/g, '');   // 'YYYY-MM-DD'
    const value = toNum(String(row?.closePrice ?? '').replace(/,/g, ''));
    if (day.length !== 8 || !Number.isFinite(value)) return;
    const t = dayStampToEpoch(day);
    if (Number.isFinite(t)) byDay.set(day, { t, value });
  });
  const points = [...byDay.values()];
  if (points.length < 2) throw new Error('네이버 환율 시세에 값이 부족함');
  points.sort((a, b) => a.t - b.t);
  return {
    points: trimToRange(points, range.days),
    prevClose: null,
    gmtoffset: 9 * 3600,
    source: '네이버 환율',
  };
}

// 대상 6개 × 기간 7개 = 42칸. 기사 응답 캐시(respCache)에 섞으면 그쪽을 밀어내므로 따로 둔다.
const INDEX_CHART_CACHE_MAX = 48;
const indexChartCache = new Map();   // "지수:기간" -> { ts, payload }

function indexChartTtl(rangeKey) {
  if (rangeKey === '1d') return 60 * 1000;         // 장중에는 계속 움직인다
  if (rangeKey === '1w') return 5 * 60 * 1000;
  return 30 * 60 * 1000;                           // 일봉은 하루 한 번만 바뀐다
}

async function buildIndexChart(key, rangeKey) {
  const target = INDEX_CHART_TARGETS[key];
  const head = { key, name: target.name, range: rangeKey, label: INDEX_CHART_RANGES[rangeKey].label };
  try {
    return { ...head, ...(await fetchIndexChartFromYahoo(target, rangeKey)) };
  } catch (e) {
    console.error(`[지수 차트] 야후 실패 (${key}/${rangeKey}):`, e.message);
    const fallback = target.fx ? fetchIndexChartFromNaverFx
      : target.world ? fetchIndexChartFromNaverForeign : fetchIndexChartFromNaverDomestic;
    return { ...head, ...(await fallback(target, rangeKey)) };
  }
}

app.get('/api/index-chart', async (req, res) => {
  const key = String(req.query.key || '');
  const rangeKey = String(req.query.range || '1m');
  if (!INDEX_CHART_TARGETS[key] || !INDEX_CHART_RANGES[rangeKey]) {
    return res.status(400).json({ error: '알 수 없는 지수 또는 기간입니다.' });
  }

  const cacheKey = `${key}:${rangeKey}`;
  const hit = indexChartCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < indexChartTtl(rangeKey)) return res.json(hit.payload);

  try {
    const payload = await buildIndexChart(key, rangeKey);
    indexChartCache.delete(cacheKey);              // 다시 넣어 '가장 최근'으로 옮긴다
    indexChartCache.set(cacheKey, { ts: Date.now(), payload });
    while (indexChartCache.size > INDEX_CHART_CACHE_MAX) {
      indexChartCache.delete(indexChartCache.keys().next().value);
    }
    res.json(payload);
  } catch (err) {
    console.error(`[지수 차트 실패] ${cacheKey}:`, err.message);
    if (hit) return res.json({ ...hit.payload, stale: true });   // 조금 낡아도 빈 화면보다 낫다
    res.status(502).json({ error: '지수 차트를 가져오지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/market-extra : 한국 기준금리 / 미국 기준금리 / 원-달러 환율
// -----------------------------------------------------------------
const FALLBACK_KR_BASE_RATE = { name: '한국 기준금리', priceStr: '2.75%', change: 0, live: false };
// 아래 조회 경로(뉴욕 연은 → FRED)가 모두 막히고, 이번 프로세스에서 한 번도 조회에
// 성공한 적이 없을 때만 쓰이는 최후의 폴백값. 자동으로 갱신되지 않으므로 live:false 다.
const FALLBACK_US_BASE_RATE = { name: '미국 기준금리', priceStr: '3.50~3.75%', change: 0, live: false };

async function fetchUsdKrw() {
  const res = await fetchWithTimeout('https://api.stock.naver.com/marketindex/exchange/FX_USDKRW', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://finance.naver.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const info = data.exchangeInfo;
  const price = toNum(info.closePrice);
  // 네이버 응답의 fluctuations / fluctuationsRatio 는 이미 부호가 붙어 있다(하락 시 "-9.20").
  // fluctuationsType(4·5=하락) 은 부호가 빠진 응답에 대비한 보조 판단용으로만 사용한다.
  const isDown = info.fluctuationsType?.code === '5' || info.fluctuationsType?.code === '4';
  const sign = isDown ? -1 : 1;
  const signedChange = sign * Math.abs(toNum(info.fluctuations));
  const signedPercent = sign * Math.abs(toNum(info.fluctuationsRatio));
  return {
    name: '원/달러 환율',
    priceStr: price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    change: signedChange,
    changePercent: signedPercent,
    live: true,
  };
}

// 직전 FOMC 대비 변동으로 볼 최대 경과일수.
// 금리 시계열에는 FOMC 일정이 없으므로, 마지막으로 금리가 바뀐 날이 이 기간보다
// 오래됐다면 그 사이 회의에서 동결된 것으로 간주한다. (FOMC 정례회의 간격은 약 6~8주)
const FOMC_RECENT_DAYS = 56;

// 외부망이 막힌 환경에서는 응답이 오지 않고 그대로 매달린다.
//   기본 8초를 다 기다릴 이유가 없어 짧게 끊고, 한 번 실패한 경로는 한동안 아예 부르지 않는다.
//   (부를 때마다 2.5초씩 헛되이 잡아먹는 걸 막는다. 접속 가능한 환경에서는
//    쿨다운이 끝날 때 다시 시도하므로 자동으로 복구된다.)
const US_RATE_TIMEOUT_MS = 2500;
const US_RATE_COOLDOWN_MS = 30 * 60 * 1000;

// 목표범위(하단·상단)와 '마지막으로 바뀐 시점'을 티커 항목 형태로 만든다.
//   prevUpper = 직전 목표범위 상단, changedAt = 새 범위가 처음 적용된 날(YYYY-MM-DD)
function makeUsBaseRateItem(lower, upper, prevUpper, changedAt) {
  const daysSinceChange = changedAt
    ? (Date.now() - new Date(`${changedAt}T00:00:00Z`).getTime()) / 86400000
    : Infinity;
  // 마지막 인상·인하가 직전 FOMC보다 이전이면 최근 회의에서는 동결된 것이므로 0으로 표시한다.
  const diff = daysSinceChange <= FOMC_RECENT_DAYS ? upper - prevUpper : 0;
  return {
    name: '미국 기준금리',
    priceStr: `${lower.toFixed(2)}~${upper.toFixed(2)}%`,
    change: diff,
    live: true,
  };
}

// [1순위] 뉴욕 연은(markets.newyorkfed.org) 기준금리 API. 키 불필요.
//   FOMC 목표범위(targetRateFrom~targetRateTo)를 응답에 그대로 담고 있어 가공이 거의 없고,
//   FRED와 달리 Render 아웃바운드에서 막히지 않는다.
//   영업일 200일치(약 9개월)면 직전 변경 시점을 찾기에 충분하다.
const NYFED_RATE_URL = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/200.json';

async function fetchUsBaseRateFromNyFed() {
  const res = await fetchWithTimeout(NYFED_RATE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  }, US_RATE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // 응답은 최신순으로 온다 → 날짜 오름차순으로 돌려놓고 뒤에서부터 훑는다.
  const rows = (Array.isArray(data?.refRates) ? data.refRates : [])
    .filter((r) => Number.isFinite(r?.targetRateFrom) && Number.isFinite(r?.targetRateTo))
    .sort((a, b) => String(a.effectiveDate).localeCompare(String(b.effectiveDate)));
  if (!rows.length) throw new Error('뉴욕 연은 응답에 목표범위가 없음');
  const latest = rows[rows.length - 1];
  let prevUpper = latest.targetRateTo;
  let changedAt = null;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].targetRateTo !== latest.targetRateTo) {
      prevUpper = rows[i].targetRateTo;
      changedAt = rows[i + 1].effectiveDate; // 새 범위가 처음 적용된 날
      break;
    }
  }
  return makeUsBaseRateItem(latest.targetRateFrom, latest.targetRateTo, prevUpper, changedAt);
}

// [2순위] FRED(세인트루이스 연은) 공개 CSV. API 키 불필요.
//   전체 기간(2008년~)을 받으면 200KB가 넘어가므로 최근 2년치만 요청한다.
//   그보다 오래전 변동은 어차피 '동결(0)'로 표시되므로 잘라도 결과가 같다.
async function fetchFredSeries(seriesId) {
  const from = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${from}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }, US_RATE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split('\n').filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [dateStr, valueStr] = lines[i].split(',');
    const value = toNum(valueStr);
    if (!Number.isNaN(value)) rows.push({ date: dateStr, value });
  }
  if (!rows.length) throw new Error(`${seriesId} 값 없음`);
  const latest = rows[rows.length - 1].value;
  let prev = latest;
  let changedAt = null;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].value !== latest) {
      prev = rows[i].value;
      changedAt = rows[i + 1].date; // 새 값이 처음 적용된 날
      break;
    }
  }
  return { latest, prev, changedAt };
}

async function fetchUsBaseRateFromFred() {
  const [upper, lower] = await Promise.all([
    fetchFredSeries('DFEDTARU'),
    fetchFredSeries('DFEDTARL'),
  ]);
  return makeUsBaseRateItem(lower.latest, upper.latest, upper.prev, upper.changedAt);
}

// 조회 경로를 앞에서부터 시도한다. 실패한 경로는 쿨다운 동안 건너뛴다.
const US_RATE_SOURCES = [
  { label: '뉴욕 연은', run: fetchUsBaseRateFromNyFed, blockedUntil: 0 },
  { label: 'FRED', run: fetchUsBaseRateFromFred, blockedUntil: 0 },
];
// 마지막으로 조회에 성공한 값. 모든 경로가 잠깐 막혀도 코드에 박아둔 값 대신 이걸 쓴다.
let lastGoodUsBaseRate = null;

async function fetchUsBaseRate() {
  for (const src of US_RATE_SOURCES) {
    if (Date.now() < src.blockedUntil) continue;
    try {
      const item = await src.run();
      src.blockedUntil = 0;
      lastGoodUsBaseRate = item;
      return item;
    } catch (e) {
      src.blockedUntil = Date.now() + US_RATE_COOLDOWN_MS;
      console.error(
        `[미국 기준금리] ${src.label} 조회 실패 · ${US_RATE_COOLDOWN_MS / 60000}분간 이 경로 호출 중단:`,
        e.message
      );
    }
  }
  return lastGoodUsBaseRate || FALLBACK_US_BASE_RATE;
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 한국은행 ECOS : 한국은행 기준금리 (통계표 722Y001, 항목 0101000, 일 단위)
// 월 단위(M)는 발표 시차 때문에 금통위 결정 당월에도 이전 값이 나올 수 있어 일 단위(D)로 조회한다.
async function fetchKrBaseRate() {
  if (!ECOS_API_KEY) return FALLBACK_KR_BASE_RATE;
  const now = new Date();
  const start = ymd(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()));
  const end = ymd(now);
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_API_KEY}/json/kr/1/1000/722Y001/D/${start}/${end}/0101000`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const rows = data?.StatisticSearch?.row;
  if (!Array.isArray(rows) || !rows.length) throw new Error('ECOS 응답 형식 해석 불가');
  const sorted = [...rows].sort((a, b) => a.TIME.localeCompare(b.TIME));
  const latest = toNum(sorted[sorted.length - 1].DATA_VALUE);
  // 마지막으로 금리가 바뀐 시점을 찾는다 (같은 값이 반복되는 일자는 건너뜀)
  let prev = latest;
  let changedAt = null;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const v = toNum(sorted[i].DATA_VALUE);
    if (v !== latest) { prev = v; changedAt = sorted[i + 1].TIME; break; }
  }
  // 직전 금통위보다 오래된 변동이면 최근 회의에서는 동결된 것으로 보고 0으로 표시한다.
  const changedDate = changedAt
    ? new Date(`${changedAt.slice(0, 4)}-${changedAt.slice(4, 6)}-${changedAt.slice(6, 8)}T00:00:00Z`)
    : null;
  const daysSinceChange = changedDate ? (Date.now() - changedDate.getTime()) / 86400000 : Infinity;
  const diff = daysSinceChange <= FOMC_RECENT_DAYS ? latest - prev : 0;
  return {
    name: '한국 기준금리',
    priceStr: `${latest.toFixed(2)}%`,
    change: diff,
    live: true,
  };
}

const MARKET_EXTRA_KEY = 'market-extra';

async function buildMarketExtra() {
  const settled = await Promise.allSettled([fetchKrBaseRate(), fetchUsBaseRate(), fetchUsdKrw()]);
  const labels = ['한국 기준금리', '미국 기준금리', '원/달러 환율'];
  const items = settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    console.error(`[market-extra 조회 실패] ${labels[i]}:`, result.reason?.message || result.reason);
    return null;
  }).filter(Boolean);
  return { items };
}

app.get('/api/market-extra', async (req, res) => {
  try {
    res.json(await cachedResponse(MARKET_EXTRA_KEY, TTL_MARKET_EXTRA, buildMarketExtra));
  } catch (err) {
    console.error('[market-extra 실패]', err.message);
    res.json({ items: [] });
  }
});

// -----------------------------------------------------------------
// /api/scfi : SCFI(상하이 컨테이너 운임지수) 종합지수
//  - 상하이해운거래소(SSE) 영문 사이트가 SCFI 표를 그릴 때 쓰는 JSON을 그대로 사용한다.
//  - SCFI는 매주 금요일 1회 발표라 '전일대비'가 아니라 '전주대비'가 된다.
//  - 노선별 수치는 로그인 회원에게만 제공되어 null로 오므로 종합지수만 쓴다.
// -----------------------------------------------------------------
const SCFI_URL = 'https://en.sse.net.cn/currentIndex?indexName=scfi';
const SCFI_TTL = 30 * 60 * 1000; // 주 1회 갱신이라 30분 캐시로 충분
let scfiCache = null; // { ts, payload }

async function fetchScfi() {
  const res = await fetchWithTimeout(SCFI_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://en.sse.net.cn/indices/scfinew.jsp',
    },
  }, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const d = data?.data;
  const comp = d?.lineDataList?.find(x => x.dataItemTypeName === 'SCFI_T') || d?.lineDataList?.[0];
  const current = toNum(comp?.currentContent);
  if (!d || Number.isNaN(current)) throw new Error('SCFI 응답 형식 해석 불가');
  return {
    name: 'SCFI 종합지수',
    current,
    previous: toNum(comp?.lastContent),
    change: toNum(comp?.absolute),
    changePercent: toNum(comp?.percentage),
    currentDate: d.currentDate || null,
    lastDate: d.lastDate || null,
    source: 'Shanghai Shipping Exchange',
    sourceUrl: 'https://en.sse.net.cn/indices/scfinew.jsp',
  };
}

app.get('/api/scfi', async (req, res) => {
  if (scfiCache && Date.now() - scfiCache.ts < SCFI_TTL) return res.json(scfiCache.payload);
  try {
    const payload = await fetchScfi();
    scfiCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    console.error('[SCFI 조회 실패]', e.message);
    // 캐시가 있으면 만료됐더라도 빈 화면보다는 마지막 값을 보여주는 편이 낫다.
    if (scfiCache) return res.json({ ...scfiCache.payload, stale: true });
    res.status(502).json({ error: 'SCFI 지수를 가져오지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/scfi/history : SCFI 종합지수 주간 시계열 (팝업 차트용)
//  - 상하이해운거래소(SSE) 본사 API는 과거 시계열을 유료 회원에게만 준다.
//    그래서 같은 수치를 그대로 옮겨 싣는 한국관세물류협회(KCLA) 페이지를 쓴다.
//    그 페이지가 차트를 그릴 때 쓰는 자바스크립트 배열을 그대로 읽어온다.
//  - 단, KCLA는 '최근 78주'만 싣는다(≒1년 6개월). 사용자가 요구한 2년·3년
//    구간을 채우려면 그보다 오래된 값이 필요한데, 과거 지수는 두 번 다시
//    바뀌지 않는 확정값이므로 아래 SCFI_HISTORY_SEED 에 붙박이로 넣어 둔다.
//    (웹 아카이브에 남은 같은 페이지의 과거 스냅샷에서 뽑은 값이다.)
//
//  [중요] KCLA 는 Render 에서 항상 404 다 (2026-07-28 확인. ?diag=1 로 잰 값이며
//    헤더·http·www·타임아웃 무엇을 바꿔도 같다. 내 PC 에서는 200 이다).
//    그래서 KCLA 만 믿으면 배포판 그래프가 2024년에서 끊긴다. 실제로 그렇게 됐었다.
//    → 대책 두 가지. 이 구조를 무너뜨리지 말 것.
//      (1) 붙박이 값을 '오늘까지' 채워 둔다. KCLA 가 0건이어도 그래프가 완전하다.
//      (2) 매주 새로 생기는 점은 SSE 현재지수(/api/scfi 와 같은 출처)에서 받는다.
//          이쪽은 Render 에서 정상이라, 방치해도 오른쪽 끝이 알아서 따라온다.
//
//  - 최종 응답 = 붙박이 과거값 + KCLA 최근값(되면) + SSE 최신 2점, 날짜 기준 병합.
//  - SCFI는 주 1회(금요일) 발표라 점 간격은 7일이다. 중국 춘절·국경절 주간은
//    발표 자체를 쉬어서 14일 간격이 생기는데, 결측이 아니라 정상이다.
// -----------------------------------------------------------------

// 2022-01-07 ~ 2026-07-24 (확정된 과거값. '날짜 값' 쌍을 공백으로 나열)
const SCFI_HISTORY_SEED = `
2022-01-07 5109.6 2022-01-14 5094.36 2022-01-21 5053.12 2022-01-28 5010.36
  2022-02-11 4980.93 2022-02-18 4946.01 2022-02-25 4818.47 2022-03-04 4746.98
  2022-03-11 4625.06 2022-03-18 4540.31 2022-03-25 4434.07 2022-04-01 4348.71
  2022-04-08 4263.66 2022-04-15 4228.65 2022-04-22 4195.98 2022-04-29 4177.3
  2022-05-06 4163.74 2022-05-13 4147.83 2022-05-20 4162.69 2022-05-27 4175.35
  2022-06-02 4208.01 2022-06-10 4233.31 2022-06-17 4221.96 2022-06-24 4216.13
  2022-07-01 4203.27 2022-07-08 4143.87 2022-07-15 4074.7 2022-07-22 3996.77
  2022-07-29 3887.85 2022-08-05 3739.72 2022-08-12 3562.67 2022-08-19 3429.83
  2022-08-26 3154.26 2022-09-02 2847.62 2022-09-09 2562.12 2022-09-16 2312.65
  2022-09-23 2072.04 2022-09-30 1922.95 2022-10-14 1814 2022-10-21 1778.69
  2022-10-28 1697.65 2022-11-07 1579.21 2022-11-11 1443.29 2022-11-18 1306.84
  2022-11-25 1229.9 2022-12-02 1171.36 2022-12-09 1138.09 2022-12-16 1123.29
  2022-12-23 1107.09 2022-12-30 1107.55 2023-01-06 1061.14 2023-01-13 1031.42
  2023-01-20 1029.75 2023-02-03 1006.89 2023-02-10 995.16 2023-02-17 974.66
  2023-02-24 946.68 2023-03-03 931.08 2023-03-10 906.55 2023-03-17 909.72
  2023-03-24 908.35 2023-03-31 923.78 2023-04-07 956.93 2023-04-14 1033.65
  2023-04-21 1037.07 2023-04-28 999.73 2023-05-05 998.29 2023-05-12 983.41
  2023-05-19 972.45 2023-05-26 983.46 2023-06-02 1028.7 2023-06-09 979.85
  2023-06-16 934.31 2023-06-21 924.29 2023-06-30 953.6 2023-07-07 931.73
  2023-07-14 979.11 2023-07-21 966.45 2023-07-28 1029.23 2023-08-04 1039.32
  2023-08-11 1043.54 2023-08-18 1031 2023-08-25 1013.78 2023-09-01 1033.67
  2023-09-08 999.25 2023-09-15 948.68 2023-09-22 911.71 2023-09-29 886.85
  2023-10-13 891.55 2023-10-20 917.66 2023-10-27 1012.6 2023-11-03 1067.88
  2023-11-10 1030.24 2023-11-17 999.92 2023-11-24 993.21 2023-12-01 1010.81
  2023-12-08 1032.21 2023-12-15 1093.52 2023-12-22 1254.99 2023-12-29 1759.57
  2024-01-05 1896.65 2024-01-12 2206.03 2024-01-19 2239.61 2024-01-26 2179.09
  2024-02-02 2217.73 2024-02-09 2166.31 2024-02-23 2109.91 2024-03-01 1979.12
  2024-03-08 1885.74 2024-03-15 1772.92 2024-03-22 1732.57 2024-03-29 1730.98
  2024-04-03 1745.43 2024-04-12 1757.04 2024-04-19 1769.54 2024-04-26 1940.63
  2024-05-10 2305.79 2024-05-17 2520.76 2024-05-24 2703.43 2024-05-31 3044.77
  2024-06-07 3184.87 2024-06-14 3379.22 2024-06-21 3475.6 2024-06-28 3714.32
  2024-07-05 3733.8 2024-07-12 3674.86 2024-07-19 3542.44 2024-07-26 3447.87
  2024-08-02 3332.67 2024-08-09 3253.89 2024-08-16 3281.36 2024-08-23 3097.63
  2024-08-30 2963.38 2024-09-06 2726.58 2024-09-13 2510.95 2024-09-20 2366.24
  2024-09-27 2135.08 2024-10-11 2062.57 2024-10-18 2062.15 2024-10-25 2185.33
  2024-11-01 2303.44 2024-11-08 2331.58 2024-11-15 2251.9 2024-11-22 2160.08
  2024-11-29 2233.83 2024-12-06 2256.46 2024-12-13 2384.4 2024-12-20 2390.17
  2024-12-27 2460.34 2025-01-03 2505.17 2025-01-10 2290.68 2025-01-17 2130.81
  2025-01-24 2045.45 2025-02-07 1896.65 2025-02-14 1758.82 2025-02-21 1595.08
  2025-02-28 1515.29 2025-03-07 1436.3 2025-03-13 1319.34 2025-03-21 1292.75
  2025-03-28 1356.88 2025-04-03 1392.78 2025-04-11 1394.68 2025-04-18 1370.58
  2025-04-25 1347.84 2025-04-30 1340.93 2025-05-09 1345.17 2025-05-16 1479.39
  2025-05-23 1586.12 2025-05-30 2072.71 2025-06-06 2240.35 2025-06-13 2088.24
  2025-06-20 1869.59 2025-06-27 1861.51 2025-07-04 1763.49 2025-07-11 1733.29
  2025-07-18 1646.9 2025-07-25 1592.59 2025-08-01 1550.74 2025-08-08 1489.68
  2025-08-15 1460.19 2025-08-22 1415.36 2025-08-29 1445.06 2025-09-05 1444.44
  2025-09-12 1398.11 2025-09-19 1198.21 2025-09-26 1114.52 2025-10-10 1160.42
  2025-10-17 1310.32 2025-10-24 1403.46 2025-10-31 1550.7 2025-11-07 1495.1
  2025-11-14 1451.38 2025-11-21 1393.56 2025-11-28 1403.13 2025-12-05 1397.63
  2025-12-12 1506.46 2025-12-19 1552.92 2025-12-26 1656.32 2026-01-09 1647.39
  2026-01-16 1574.12 2026-01-23 1457.86 2026-01-30 1316.75 2026-02-06 1266.56
  2026-02-13 1251.46 2026-02-27 1333.11 2026-03-06 1489.19 2026-03-13 1710.35
  2026-03-20 1706.95 2026-03-27 1826.77 2026-04-03 1854.96 2026-04-10 1890.77
  2026-04-17 1886.54 2026-04-24 1875.26 2026-04-30 1911.4 2026-05-08 1954.21
  2026-05-15 2140.66 2026-05-22 2218.15 2026-05-29 2571.73 2026-06-05 2726.48
  2026-06-12 2985.22 2026-06-19 3121.69 2026-06-27 3239.64 2026-07-03 3326.87
  2026-07-10 3184.82 2026-07-17 3080.31 2026-07-24 3062.95
`;

const SCFI_HISTORY_URL = 'https://www.kcla.kr/web/inc/html/4-1_3.asp';
const SCFI_HISTORY_TTL = 6 * 60 * 60 * 1000; // 주 1회 갱신이라 6시간이면 넉넉하다
const SCFI_MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
let scfiHistoryCache = null; // { ts, payload }

function scfiSeedPoints() {
  const tokens = SCFI_HISTORY_SEED.trim().split(/\s+/);
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const value = Number(tokens[i + 1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[i]) && Number.isFinite(value)) {
      out.push({ date: tokens[i], value });
    }
  }
  return out;
}

// KCLA 페이지 안의 jqplot 배열 : ['24-Jul-26', 3062.95] 형태를 뽑아 ISO 날짜로 바꾼다.
async function fetchScfiHistoryRecent() {
  const res = await fetchWithTimeout(SCFI_HISTORY_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    },
  }, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  for (const m of html.matchAll(/'(\d{2})-([A-Za-z]{3})-(\d{2})'\s*,\s*([\d.]+)/g)) {
    const month = SCFI_MONTHS[m[2]];
    const value = Number(m[4]);
    if (!month || !Number.isFinite(value)) continue;
    out.push({ date: `20${m[3]}-${month}-${m[1]}`, value });
  }
  if (out.length < 10) throw new Error('SCFI 시계열 형식 해석 불가');
  return out;
}

// SSE 현재지수(위의 /api/scfi 와 같은 출처)에서 이번 주·지난주 점을 뽑는다.
//  - KCLA 가 막혀도 이쪽은 Render 에서 정상이라, 매주 새 점이 여기로 들어온다.
//    붙박이 과거값 + 이 두 점만으로도 그래프의 오른쪽 끝이 계속 최신을 유지한다.
async function fetchScfiEdgePoints() {
  const d = scfiCache && Date.now() - scfiCache.ts < SCFI_TTL ? scfiCache.payload : await fetchScfi();
  const out = [];
  if (d.currentDate && Number.isFinite(d.current)) out.push({ date: d.currentDate, value: d.current });
  if (d.lastDate && Number.isFinite(d.previous)) out.push({ date: d.lastDate, value: d.previous });
  return out;
}

async function buildScfiHistory() {
  let recent = [];
  let recentOk = true;
  let recentError = null;
  try {
    recent = await fetchScfiHistoryRecent();
  } catch (e) {
    recentOk = false;
    recentError = `${e.name}: ${e.message}${e.cause ? ' / ' + e.cause.message : ''}`;
    console.error('[SCFI 시계열 조회 실패]', recentError);
  }

  let edge = [];
  try {
    edge = await fetchScfiEdgePoints();
  } catch (e) {
    console.error('[SCFI 최신 점 조회 실패]', e.message);
  }

  // 같은 날짜가 겹치면 나중에 넣는 최신 수집분이 이긴다.
  const byDate = new Map();
  for (const p of scfiSeedPoints()) byDate.set(p.date, p.value);
  for (const p of recent) byDate.set(p.date, p.value);
  for (const p of edge) byDate.set(p.date, p.value);
  const points = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value }));
  return {
    points,
    recentOk,
    recentError,   // 실패했을 때 이유. Render 로그를 못 볼 때 여기로 확인한다.
    source: 'Shanghai Shipping Exchange (via 한국관세물류협회)',
    sourceUrl: SCFI_HISTORY_URL,
  };
}

// -----------------------------------------------------------------
// /api/scfi/history?diag=1 : 최근 구간을 못 받아올 때 원인을 Render 에서 직접 재 본다.
//   Gemini 때와 같은 문제다 — 로컬에서는 되는데 Render 에서만 안 되면
//   서버가 스스로 여러 방식으로 시도해 보고 결과를 표로 돌려주는 수밖에 없다.
//   (PERFORMANCE.md 의 /api/gemini-models?test=1 과 같은 방식)
// -----------------------------------------------------------------
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

async function scfiDiag() {
  const cases = [
    ['현재 방식 (https + UA)', 'https://www.kcla.kr/web/inc/html/4-1_3.asp', { 'User-Agent': UA_BROWSER }, 10000],
    ['헤더 없음', 'https://www.kcla.kr/web/inc/html/4-1_3.asp', {}, 10000],
    ['브라우저 헤더 전체', 'https://www.kcla.kr/web/inc/html/4-1_3.asp', {
      'User-Agent': UA_BROWSER,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.kcla.kr/web/inc/html/4-1.asp',
    }, 10000],
    ['http (평문)', 'http://www.kcla.kr/web/inc/html/4-1_3.asp', { 'User-Agent': UA_BROWSER }, 10000],
    ['www 없이', 'https://kcla.kr/web/inc/html/4-1_3.asp', { 'User-Agent': UA_BROWSER }, 10000],
    ['오래 기다리기 (30초)', 'https://www.kcla.kr/web/inc/html/4-1_3.asp', { 'User-Agent': UA_BROWSER }, 30000],
    ['대조군: SSE 현재지수', 'https://en.sse.net.cn/currentIndex?indexName=scfi', { 'User-Agent': UA_BROWSER }, 10000],
  ];
  const rows = [];
  for (const [name, url, headers, timeout] of cases) {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(url, { headers, redirect: 'follow' }, timeout);
      const body = await r.text();
      const hits = [...body.matchAll(/'(\d{2})-([A-Za-z]{3})-(\d{2})'\s*,\s*([\d.]+)/g)].length;
      rows.push({
        name, ms: Date.now() - t0, status: r.status, bytes: body.length, 지수개수: hits,
        server: r.headers.get('server') || null,
        // 실패했을 때 어떤 화면이 온 건지(WAF 차단인지 진짜 404인지) 보려면 본문이 필요하다.
        body: r.ok && hits ? null : body.replace(/\s+/g, ' ').slice(0, 400),
      });
    } catch (e) {
      rows.push({ name, ms: Date.now() - t0, error: `${e.name}: ${e.message}${e.cause ? ' / ' + e.cause.message : ''}` });
    }
  }
  return rows;
}

app.get('/api/scfi/history', async (req, res) => {
  if (req.query.diag === '1') {
    return res.json({ ranAt: new Date().toISOString(), cases: await scfiDiag() });
  }
  if (scfiHistoryCache && Date.now() - scfiHistoryCache.ts < SCFI_HISTORY_TTL) {
    return res.json(scfiHistoryCache.payload);
  }
  try {
    const payload = await buildScfiHistory();
    // 최신 구간을 못 받아온 응답까지 6시간 물고 있으면 복구가 늦다. 성공했을 때만 캐시한다.
    if (payload.recentOk) scfiHistoryCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    console.error('[SCFI 시계열 구성 실패]', e.message);
    if (scfiHistoryCache) return res.json({ ...scfiHistoryCache.payload, stale: true });
    res.status(502).json({ error: 'SCFI 시계열을 가져오지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// [속도] 백그라운드 프리워밍
//   느림의 정체는 '원문 본문을 처음 읽는 시간'이다. 그 값을 사용자가 아니라
//   서버가 미리 치르게 한다. 기동 직후 한 번, 이후 주기적으로 섹션을 훑어
//   본문 캐시를 채워두면 사용자는 항상 캐시 히트 상태를 만난다.
//
//   섹션은 한 번에 하나씩(순차) 돌린다. 동시에 돌리면 프리워밍이 실사용
//   요청과 외부 연결을 놓고 경쟁해 오히려 응답을 느리게 만든다.
//
//   [중요] 반드시 '천천히' 돌아야 한다. 섹션을 쉬지 않고 이어 돌리면 네이버
//   검색 API가 429(Rate Limited)를 돌려주고, 그러면 프리워밍은 물론 같은
//   시간대의 실사용 요청까지 빈 결과를 받는다. 섹션 사이에 간격을 둔다.
// -----------------------------------------------------------------
// 30분마다. 한 회차에 네이버 검색 API를 약 78회 쓰므로 하루 약 3,700회다.
//   (무료 한도 25,000회/일의 약 15% — 나머지는 실사용 요청 몫으로 남긴다)
// 본문 캐시 TTL이 6시간이라 이 주기로도 캐시는 계속 데워진 상태로 유지된다.
const WARM_INTERVAL = 30 * 60 * 1000;
// 기동 직후 30초는 프리워밍을 미룬다.
//   무료 플랜은 접속이 없으면 잠들었다가 접속이 오면 깨어난다. 즉 '기동'은
//   대개 '누군가 방금 접속했다'는 뜻이다. 이때 바로 프리워밍을 돌리면 그
//   사람의 첫 페이지 로드와 외부 연결을 놓고 경쟁해 오히려 느려진다.
//   먼저 복원된 캐시로 그 사람을 처리하고, 그다음에 프리워밍이 보충한다.
const WARM_START_DELAY = 30 * 1000;
const WARM_GAP = 2500;                  // 섹션 사이 간격 (네이버 호출량 분산)
// 이 시간 안에 이미 갱신된 칸은 프리워밍이 건너뛴다.
//   재배포 직후엔 접속한 사람의 요청이 프리워밍보다 먼저 캐시를 채운다.
//   그걸 또 채우면 네이버 호출만 두 번 쓰고 사용자 요청과 경쟁만 한다.
//   건너뛰어도 30분 뒤 다음 회차가 갱신하므로 캐시가 상하지 않는다.
//   (섹션 stale 이 60분이라 최악의 경우 35분 → 여유 있음)
const WARM_SKIP_IF_YOUNGER = 5 * 60 * 1000;
let warming = false;
// 마지막 프리워밍이 데운 칸 목록. 종료 직전에 이 칸들의 사본을 남기는 데 쓴다.
let lastWarmKeys = [];

// 프리워밍은 '완성된 응답'을 미리 만들어 캐시에 넣어 둔다.
//   중요 : 화면이 실제로 보내는 요청과 조건이 완전히 같아야 캐시 키가 맞아떨어진다.
//   하나라도 다르면 다른 칸에 저장돼 데워봐야 헛일이 된다.
//   (화면 기본값 : 게재기간 1일=24, 정렬 정확도순=sim, 섹션당 30건, 브리핑 10건)
const WARM_HOURS = '24';
const WARM_SORT = 'sim';
const WARM_PER_SECTION = 30;
const WARM_BRIEFING_LIMIT = 10;

// 프리워밍이 만든 캐시를 화면이 그대로 쓰려면, 양쪽이 같은 키워드로 계산해야 한다.
//   화면은 설정에 없는 섹션을 자기 기본값으로 채워서 보내지만,
//   서버 프리워밍은 저장된 설정만 본다. 그래서 저장된 설정에 빠진 섹션이 있으면
//   키가 어긋나 프리워밍이 조용히 헛돈다(느려지는 게 아니라 '안 빨라진다').
//   눈에 보이게 로그로 남긴다.
function warnUncoveredSections(kwMap) {
  const needed = [
    ...ALL_SECTIONS,
    ...LOGISTICS_SECTIONS,
    ...STOCK_SECTIONS,
    ...SPORTS_SECTIONS,
    ...ECONOMY_SECTIONS,                   // [추가] 경제 엄선 목록이 이 섹션을 쓴다
    ...Object.values(DIGEST_EXTRA_PARENTS), // [추가] 스포츠 상위 (전체 화면엔 없는 섹션)
    ...BRIEFING_SOURCES.map((s) => ({ key: s.cat })),
  ];
  const missing = [...new Set(
    needed.filter((sec) => !(kwMap && kwMap[sec.key])).map((sec) => sec.key)
  )];
  if (missing.length) {
    console.warn(
      `[프리워밍] 저장된 키워드에 없는 섹션 ${missing.length}개: ${missing.join(', ')}\n` +
      `           이 섹션들은 화면 요청과 캐시 키가 달라져 미리 데워도 효과가 없습니다.\n` +
      `           설정 화면에서 한 번 저장하면 해결됩니다.`
    );
  }
}

// 접속했을 때 가장 먼저 보이는 화면부터 순서대로 데운다.
function warmJobs(kwMap) {
  const secOpts = { limit: WARM_PER_SECTION, hours: WARM_HOURS, sort: WARM_SORT };
  const briefOpts = { limit: WARM_BRIEFING_LIMIT, hours: WARM_HOURS };

  const jobs = [
    {
      name: 'briefing',
      key: buildBriefingKey(briefOpts, kwMap),
      run: () => buildBriefing(briefOpts, kwMap),
    },
    {
      name: 'all/sections',
      key: buildSectionsKey('all', ALL_SECTIONS, secOpts, kwMap),
      run: () => buildAllSections(secOpts, kwMap),
    },
  ];

  // [수정] 하위 섹션이 있는 상위 섹션(물류·경제·증시·스포츠)을 누르면
  //   이제 '전체보기'가 아니라 엄선 목록(digest)이 뜬다. 그래서 데울 대상도 digest 로 바꿨다.
  //   건수·정렬은 캐시 키에 없으므로 여기서 정하지 않는다.
  const digestOpts = { hours: WARM_HOURS };
  DIGEST_BASES.forEach(([base, SECTIONS]) => {
    const sources = digestSources(base, SECTIONS);
    jobs.push({
      name: `${base}/digest`,
      key: buildDigestKey(base, sources, digestOpts, kwMap),
      run: () => buildDigest(sources, digestOpts, kwMap),
    });
  });

  return jobs;
}

// 프리워밍에 쓸 키워드. 반드시 '화면이 실제로 쓰는 값'과 같아야 한다.
//   다르면 엉뚱한 기사로 캐시를 데우게 되어 프리워밍이 헛돈다.
//   로컬 파일은 재배포 때 사라지고 기동 직후엔 비어 있으므로, 원본인
//   Supabase를 먼저 읽고 실패했을 때만 파일 캐시로 물러선다.
async function readWarmKeywords() {
  if (SUPABASE_ENABLED) {
    try {
      return await readKeywordsFromSupabase();
    } catch (e) {
      console.error('[프리워밍] 키워드 조회 실패, 파일 캐시 사용:', e.message);
    }
  }
  return readKeywordsFile();
}

async function warmCache() {
  if (warming) return;              // 이전 회차가 아직 안 끝났으면 건너뛴다
  warming = true;
  const t0 = Date.now();
  const before = articleTextCache.size;
  const kwMap = await readWarmKeywords();
  // 지표 티커(market-extra)는 네이버 API를 쓰지 않아 429 걱정이 없다.
  //   기사 프리워밍을 기다리게 하지 말고 옆에서 같이 데운다.
  runProducer(MARKET_EXTRA_KEY, buildMarketExtra)
    .catch((e) => console.error('[프리워밍] market-extra 실패:', e.message));
  try {
    warnUncoveredSections(kwMap);
    const jobs = warmJobs(kwMap);
    let skipped = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      // 방금 사용자 요청이 채워 둔 칸을 또 채우면 네이버 호출만 두 번 쓴다.
      //   재배포 직후엔 접속한 사람의 요청이 먼저 캐시를 채우므로 특히 겹친다.
      //   최근에 갱신된 칸은 건너뛴다 (다음 회차에 정상적으로 갱신된다).
      const hit = respCache.get(job.key);
      if (hit && Date.now() - hit.ts < WARM_SKIP_IF_YOUNGER) { skipped++; continue; }

      if (i > 0) await sleep(WARM_GAP);   // 네이버 API 429 방지
      try {
        // cachedResponse 가 아니라 runProducer 를 직접 부른다.
        //   cachedResponse 는 '아직 쓸 만하면 그냥 돌려주는' 함수라 갱신이 안 될 수 있다.
        //   프리워밍은 무조건 새로 받아 캐시를 채우는 게 목적이다.
        //   warmFlag.run 으로 감싸 이 안의 네이버 호출을 '프리워밍'으로 표시한다.
        //   → 사용자 요청이 슬롯을 먼저 쓰게 된다 (naverSlotAcquire 참고).
        await warmFlag.run(true, () => runProducer(job.key, job.run));
      } catch (e) {
        console.error(`[프리워밍] ${job.name} 실패:`, e.message);   // 하나 실패가 전체를 멈추지 않게
      }
    }
    // 캐시가 막 채워진 지금이 사본을 남기기 가장 좋은 시점이다.
    //   종료 훅은 배포판이 프로세스를 즉시 죽이면 실행되지 않으므로 믿지 않는다.
    saveArticleCache();
    await saveArticleCacheToSupabase();
    // 완성된 응답도 사본을 남긴다 → 다음 재배포 때 첫 손님이 이걸 받는다.
    //   담는 순서 = 중요한 순서. 용량이 넘치면 뒤쪽(스포츠 등)부터 빠진다.
    lastWarmKeys = [MARKET_EXTRA_KEY, ...jobs.map((j) => j.key)];
    await saveRespCacheToSupabase(lastWarmKeys);
    console.log(
      `[프리워밍] 완료 ${Math.round((Date.now() - t0) / 1000)}초 · ` +
      `본문 캐시 ${before} → ${articleTextCache.size}건 · 응답 캐시 ${respCache.size}건` +
      (skipped ? ` · 최근 갱신돼 건너뜀 ${skipped}건` : '')
    );
  } finally {
    warming = false;
  }
}

app.listen(PORT, () => {
  console.log(`네이버 뉴스 프록시 서버 실행 중: http://localhost:${PORT}`);
  setTimeout(warmCache, WARM_START_DELAY).unref();
  setInterval(warmCache, WARM_INTERVAL).unref();
});
