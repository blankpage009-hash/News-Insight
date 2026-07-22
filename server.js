// server.js
// 네이버 검색 API(뉴스) 프록시 서버 - Naver API HUB 사용
//
// [이번 업데이트]
//  1) /api/briefing : 카테고리 균형(속보 쏠림 방지) 라운드로빈 선발
//  2) /api/article-summary : 원문 본문에서 잡음 제거 후 핵심 문장 N개(기본 2개)만 반환
//  3) /api/all/sections, /api/logistics/sections : perSection 파라미터로 노출 개수 조절
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

async function naverSearchRaw(query, display = 30, sort = 'date', start = 1) {
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

// /api/breaking : 프런트 '속보' 카테고리 전용
app.get('/api/breaking', async (req, res) => {
  const limit = Math.min(Number(req.query.display) || 20, 50);
  const kwMap = parseKw(req.query.kw);
  const { terms, exclude } = resolveSectionKw(kwMap, { key: 'breaking', terms: ['속보'] });
  try {
    res.json({ items: await fetchBreaking(limit, terms, exclude) });
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

app.get('/api/briefing', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 30);
  const { dateFrom, dateTo, hours, kw } = req.query;
  const kwMap = parseKw(kw);

  try {
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
    if (!pool.length) return res.json({ items: [] });

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

    res.json({ items: picked.map(({ _tokens, _score, ...it }) => it) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '브리핑을 구성하지 못했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/all/sections : 전체 카테고리 그룹 조회
// -----------------------------------------------------------------
app.get('/api/all/sections', async (req, res) => {
  const { dateFrom, dateTo, perSection = '5', hours, sort, kw } = req.query;
  const kwMap = parseKw(kw);
  const limit = Math.min(Number(perSection) || 5, 30);
  try {
    const sections = await Promise.all(
      ALL_SECTIONS.map(async (sec) => {
        const { terms, exclude } = resolveSectionKw(kwMap, sec);
        const items = sec.breaking
          ? await fetchBreaking(limit, terms, exclude)
          : collapseEvents(await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, domain: sec.domain, exclude }), sort).slice(0, limit);
        return { key: sec.key, label: sec.label, items };
      })
    );
    res.json({ sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// 하위 카테고리 공통 라우트 등록
//  /api/{base}/sections        : 하위 카테고리 전체 묶음
//  /api/{base}/section/:key    : 하위 카테고리 1개
//  -> 물류(logistics), 증시(stock) 두 곳에서 함께 사용
// -----------------------------------------------------------------
function registerSectionRoutes(base, SECTIONS) {
  app.get(`/api/${base}/sections`, async (req, res) => {
    const { dateFrom, dateTo, perSection = '5', hours, sort, kw } = req.query;
    const kwMap = parseKw(kw);
    const limit = Math.min(Number(perSection) || 5, 30);
    try {
      const sections = await Promise.all(
        SECTIONS.map(async (sec) => {
          const { terms, exclude } = resolveSectionKw(kwMap, sec);
          const items = await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, domain: sec.domain, exclude });
          return { key: sec.key, label: sec.label, items: collapseEvents(items, sort).slice(0, limit) };
        })
      );
      res.json({ sections });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
  });

  app.get(`/api/${base}/section/:key`, async (req, res) => {
    const sec = SECTIONS.find((s) => s.key === req.params.key);
    if (!sec) return res.status(404).json({ error: '존재하지 않는 카테고리입니다.' });

    const { dateFrom, dateTo, display = '20', hours, sort, kw } = req.query;
    const kwMap = parseKw(kw);
    const { terms, exclude } = resolveSectionKw(kwMap, sec);
    try {
      const limit = Math.min(Number(display) || 20, 50);
      const items = await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, sort, domain: sec.domain, exclude });
      res.json({ items: collapseEvents(items, sort).slice(0, limit), label: sec.label });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
  });
}

registerSectionRoutes('logistics', LOGISTICS_SECTIONS);
registerSectionRoutes('stock', STOCK_SECTIONS);
registerSectionRoutes('sports', SPORTS_SECTIONS);   // [추가] 스포츠 하위 섹션
registerSectionRoutes('economy', ECONOMY_SECTIONS); // [추가] 경제 하위 섹션(거시경제/시장)

// -----------------------------------------------------------------
// /api/topic/:key : 단일 상위 섹션 (경제 / 정치·사회 / 글로벌 / 속보 등)
//   '전체(all)' 화면과 완전히 같은 키워드·도메인·세팅을 사용한다.
//   → 어느 화면에서 보든 같은 세팅이 적용되어 결과가 일관된다.
// -----------------------------------------------------------------
app.get('/api/topic/:key', async (req, res) => {
  const sec = ALL_SECTIONS.find((s) => s.key === req.params.key);
  if (!sec) return res.status(404).json({ error: '존재하지 않는 섹션입니다.' });

  const { dateFrom, dateTo, display = '20', hours, sort, kw } = req.query;
  const kwMap = parseKw(kw);
  const { terms, exclude } = resolveSectionKw(kwMap, sec);
  try {
    const limit = Math.min(Number(display) || 20, 50);
    const items = sec.breaking
      ? await fetchBreaking(limit, terms, exclude)
      : collapseEvents(await searchByTerms(terms, { display: limit, dateFrom, dateTo, hours, sort, domain: sec.domain, exclude }), sort).slice(0, limit);
    res.json({ items, label: sec.label });
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
// [429 대응] 무료 한도가 가장 넉넉한 Flash-Lite 계열을 앞쪽에 둔다.
//   (분당 요청 한도가 커서 429가 훨씬 덜 난다.)
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL, // .env 에 지정했다면 1순위
  'gemini-2.5-flash-lite',  // 무료 한도 가장 넉넉 → 최우선
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-3-flash',
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
- 이 기사를 이해하는 데 꼭 필요한 핵심 용어·개념·전문 용어를 2~3개만 골라라.
- 누구나 아는 쉬운 단어는 고르지 마라. (예: 정부, 회사, 오늘 같은 단어는 제외)
- explain은 한두 문장으로, 배경지식이 없는 사람도 바로 이해할 수 있게 쉽게 풀어써라.
- 본문에 어려운 용어가 전혀 없으면 빈 배열 []로 둬라.

[출력 형식] 아래 JSON만 출력. 다른 말 금지.
{
  "headline": "핵심을 담은 짧은 제목",
  "lead": "핵심을 3~4문장으로 요약한 문단",
  "table": [{ "key": "항목명", "value": "내용" }],
  "bullets": ["핵심 포인트 문장"],
  "keywords": [{ "term": "용어", "explain": "쉬운 설명" }]
}`;

// 모델 하나로 실제 호출 (실패하면 status를 담은 에러를 던진다)
async function callGeminiOnce(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
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
  } finally {
    clearTimeout(timer);
  }
}

// [추가] 구글 쪽 일시적 장애(모델 과부하 등) : 우리 잘못이 아니라 기다리거나 우회하면 되는 상태
//   503 UNAVAILABLE = "This model is currently experiencing high demand" (가장 흔함)
//   500/502/504 = 구글 내부 오류 · 게이트웨이 오류
const GEMINI_TRANSIENT_STATUS = [500, 502, 503, 504];
function isTransientGeminiError(e) { return GEMINI_TRANSIENT_STATUS.includes(e?.status); }

// 후보 목록을 돌면서 '되는 모델'을 찾아 한 번 호출한다
//  - 404(모델 없음)  → 다음 후보로
//  - 503 등 일시 장애 → 그 모델이 붐비는 것이므로 역시 다음 후보로 우회
async function callGeminiModels(prompt) {
  const list = ACTIVE_MODEL ? [ACTIVE_MODEL] : MODEL_CANDIDATES;
  let lastErr;

  for (const model of list) {
    try {
      const out = await callGeminiOnce(model, prompt);
      if (ACTIVE_MODEL !== model) console.log(`[Gemini] 사용 모델 확정: ${model}`);
      ACTIVE_MODEL = model;
      return out;
    } catch (e) {
      lastErr = e;
      if (e.status === 404) {
        console.warn(`[Gemini] ${model} 사용 불가(404) → 다음 후보 시도`);
        // 확정돼 있던 모델이 갑자기 막혔다면 확정을 풀고 전체 후보를 다시 시도
        if (ACTIVE_MODEL === model) { ACTIVE_MODEL = null; return callGeminiModels(prompt); }
        continue; // 모델이 없는 경우만 다음 후보로
      }
      if (isTransientGeminiError(e)) {
        console.warn(`[Gemini] ${model} 일시 장애(${e.status}) → 다른 모델로 우회 시도`);
        // 확정 모델이 붐비는 중 → 확정을 풀고 나머지 후보들을 훑는다
        if (ACTIVE_MODEL === model) { ACTIVE_MODEL = null; return callGeminiModels(prompt); }
        continue;
      }
      throw e; // 400 / 429 등은 모델 문제가 아니므로 위로 던진다
    }
  }
  // 모든 후보가 일시 장애였다면 그 상태(503 등)를 그대로 위로 올려 재시도 대상이 되게 한다
  if (isTransientGeminiError(lastErr)) throw lastErr;
  throw new Error(`쓸 수 있는 Gemini 모델을 찾지 못했습니다. /api/gemini-models 로 확인해 보세요. (${lastErr?.message || ''})`);
}

// -----------------------------------------------------------------
// [429 대응 ①] 호출 큐 : 한 번에 하나씩 + 최소 간격을 강제한다.
//   여러 사람이 동시에 '주요 내용'을 눌러도 순서대로 내보내
//   분당 한도를 넘지 않게 한다. (= 대기열 + "N초에 1회")
// -----------------------------------------------------------------
const GEMINI_MIN_INTERVAL = 6000; // ms. 호출 사이 최소 6초 간격 (분당 한도 아래로 유지)
let geminiChain = Promise.resolve();
let lastGeminiAt = 0;

function enqueueGemini(task) {
  const run = geminiChain.then(async () => {
    const wait = GEMINI_MIN_INTERVAL - (Date.now() - lastGeminiAt);
    if (wait > 0) await sleep(wait);     // 직전 호출과 간격 벌리기
    lastGeminiAt = Date.now();
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
    res.json({ active: ACTIVE_MODEL, candidates: MODEL_CANDIDATES, usable });
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
// /api/indices : KOSPI / KOSDAQ / NASDAQ / S&P 500 / DOW JONES
// -----------------------------------------------------------------
const INDEX_TARGETS = [
  { codes: ['KOSPI'], name: 'KOSPI', world: false },
  { codes: ['KOSDAQ'], name: 'KOSDAQ', world: false },
  { codes: ['.IXIC'], name: 'NASDAQ', world: true },
  { codes: ['.INX', '.SPX', 'SPI@SPX'], name: 'S&P 500', world: true },
  { codes: ['.DJI'], name: 'DOW JONES', world: true },
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
  const { codes, name } = target;
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

app.get('/api/indices', async (req, res) => {
  const settled = await Promise.allSettled(INDEX_TARGETS.map(fetchOneIndex));

  const items = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') items.push(result.value);
    else console.error(`[지수 조회 실패] ${INDEX_TARGETS[i].name}:`, result.reason?.message || result.reason);
  });

  if (items.length === 0) {
    return res.status(502).json({ error: '증시 지수 정보를 가져오지 못했습니다.', items: [] });
  }
  res.json({ items });
});

// -----------------------------------------------------------------
// /api/market-extra : 한국 기준금리 / 미국 기준금리 / 원-달러 환율
// -----------------------------------------------------------------
const FALLBACK_KR_BASE_RATE = { name: '한국 기준금리', priceStr: '2.75%', change: 0, live: false };
// FRED(fred.stlouisfed.org)가 일부 배포 환경(Render 등)의 아웃바운드 네트워크에서 막혀 있어
// 매번 타임아웃되는 경우를 대비한 폴백값. FRED 접속이 가능한 환경에서는 사용되지 않는다.
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
// FRED 시리즈에는 FOMC 일정이 없으므로, 마지막으로 금리가 바뀐 날이 이 기간보다
// 오래됐다면 그 사이 회의에서 동결된 것으로 간주한다. (FOMC 정례회의 간격은 약 6~8주)
const FOMC_RECENT_DAYS = 56;

// FRED(세인트루이스 연은) 공개 CSV. API 키 불필요.
// 최신값과, 마지막으로 값이 바뀐 시점(직전 값·변경일)을 반환한다.
async function fetchFredSeries(seriesId) {
  const res = await fetchWithTimeout(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
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

async function fetchUsBaseRate() {
  try {
    const [upper, lower] = await Promise.all([
      fetchFredSeries('DFEDTARU'),
      fetchFredSeries('DFEDTARL'),
    ]);
    const daysSinceChange = upper.changedAt
      ? (Date.now() - new Date(`${upper.changedAt}T00:00:00Z`).getTime()) / 86400000
      : Infinity;
    // 마지막 인상·인하가 직전 FOMC보다 이전이면 최근 회의에서는 동결된 것이므로 0으로 표시한다.
    const diff = daysSinceChange <= FOMC_RECENT_DAYS ? upper.latest - upper.prev : 0;
    return {
      name: '미국 기준금리',
      priceStr: `${lower.latest.toFixed(2)}~${upper.latest.toFixed(2)}%`,
      change: diff,
      live: true,
    };
  } catch (e) {
    console.error('[미국 기준금리 조회 실패, 폴백값 사용]', e.message);
    return FALLBACK_US_BASE_RATE;
  }
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

app.get('/api/market-extra', async (req, res) => {
  const settled = await Promise.allSettled([fetchKrBaseRate(), fetchUsBaseRate(), fetchUsdKrw()]);
  const labels = ['한국 기준금리', '미국 기준금리', '원/달러 환율'];
  const items = settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    console.error(`[market-extra 조회 실패] ${labels[i]}:`, result.reason?.message || result.reason);
    return null;
  }).filter(Boolean);
  res.json({ items });
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
const WARM_START_DELAY = 5 * 1000;      // 기동 직후 서버가 자리잡을 시간
const WARM_GAP = 2500;                  // 섹션 사이 간격 (네이버 호출량 분산)
let warming = false;

function warmTargets() {
  return [
    ...ALL_SECTIONS,
    ...LOGISTICS_SECTIONS,
    ...STOCK_SECTIONS,
    ...SPORTS_SECTIONS,
    ...ECONOMY_SECTIONS,
  ];
}

async function warmCache() {
  if (warming) return;              // 이전 회차가 아직 안 끝났으면 건너뛴다
  warming = true;
  const t0 = Date.now();
  const before = articleTextCache.size;
  const kwMap = readKeywordsFile();  // 사용자가 저장한 키워드로 데워야 실제 화면과 맞는다
  try {
    const targets = warmTargets();
    for (let i = 0; i < targets.length; i++) {
      const sec = targets[i];
      if (i > 0) await sleep(WARM_GAP);   // 네이버 API 429 방지
      try {
        const { terms, exclude } = resolveSectionKw(kwMap, sec);
        if (sec.breaking) await fetchBreaking(30, terms, exclude);
        else await searchByTerms(terms, { display: 30, hours: '24', domain: sec.domain, exclude });
      } catch (e) {
        console.error(`[프리워밍] ${sec.key} 실패:`, e.message);   // 한 섹션 실패가 전체를 멈추지 않게
      }
    }
    // 캐시가 막 채워진 지금이 사본을 남기기 가장 좋은 시점이다.
    //   종료 훅은 배포판이 프로세스를 즉시 죽이면 실행되지 않으므로 믿지 않는다.
    saveArticleCache();
    await saveArticleCacheToSupabase();
    console.log(
      `[프리워밍] 완료 ${Math.round((Date.now() - t0) / 1000)}초 · 본문 캐시 ${before} → ${articleTextCache.size}건`
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
