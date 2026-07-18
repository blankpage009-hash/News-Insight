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

const app = express();
const PORT = process.env.PORT || 3000;

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.warn('[경고] .env 에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 없습니다.');
}

app.use(cors());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'news-insight-naver.html'));
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
              '공급망','SCM','허브터미널','수출입','이커머스','유통'],
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
const VERIFY_CONCURRENCY = 6;

const articleTextCache = new Map(); // url -> { ts, text }
const ARTICLE_TTL = 1000 * 60 * 30;

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
async function fetchArticleText(url) {
  if (!url || /^https?:\/\//i.test(url) === false) return '';
  const c = articleTextCache.get(url);
  if (c && Date.now() - c.ts < (c.text ? ARTICLE_TTL : FAIL_TTL)) return c.text;

  let text = '';
  try {
    const html = await fetchHtml(url);
    if (html) text = extractBodyFromHtml(html);
  } catch {
    text = '';
  }
  articleTextCache.set(url, { ts: Date.now(), text });
  return text;
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
async function fetchArticleTextSmart(url, naverUrl, minLen = 200) {
  let best = '';
  for (const u of articleUrlCandidates(url, naverUrl)) {
    const t = await fetchArticleText(u);
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

async function refineByDomain(items, terms, domKey) {
  const dom = DOMAINS[domKey];
  if (!dom) return items;

  const pass = [];
  const pending = [];

  for (const it of items) {
    const head = `${it.title || ''} ${(it.summary || []).join(' ')}`;

    if (hitCount(it.title, dom.exclude) > 0) continue;   // 제목 제외어 → 탈락
    if (hitCount(head, dom.exclude) >= 2) continue;      // 요약에도 제외어 다수 → 탈락

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
    if (hitCount(lead, dom.exclude) >= 2) return null;
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

async function naverSearchRaw(query, display = 30, sort = 'date') {
  const params = new URLSearchParams({
    query,
    display: String(Math.min(Number(display) || 30, 100)),
    start: '1',
    sort: sort === 'sim' ? 'sim' : 'date',
  });

  const res = await fetch(`https://naverapihub.apigw.ntruss.com/search/v1/news?${params.toString()}`, {
    headers: {
      'X-NCP-APIGW-API-KEY-ID': NAVER_CLIENT_ID,
      'X-NCP-APIGW-API-KEY': NAVER_CLIENT_SECRET,
    },
  });

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
  } = opts;

  // [D] 넉넉히 받아온 뒤 서버에서 추린다 (요청 비용은 동일)
  const per = Number(fetchCount) || Math.max(30, Math.min(100, (Number(display) || 15) * 4));

  const resultsPerTerm = await Promise.all(
    terms.map(async (term) => {
      const queries = expand ? expandTerm(term) : [term]; // [F]
      const lists = await Promise.all(
        queries.map(async (q) => {
          try {
            return await naverSearchRaw(q, per, sort);
          } catch (e) {
            console.error(`[검색 실패] "${q}":`, e.message);
            return [];
          }
        })
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
    if (domain) merged = await refineByDomain(merged, terms, domain); // [I] 맥락 검증
    if (sort !== 'sim') merged.sort(byDate);
  }
  return merged;
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
];

// [추가] 증시 하위 카테고리
const STOCK_SECTIONS = [
  { key: 'stock_domestic', label: '국내 증시 시황',
    terms: ['코스피', '코스닥', '국내 증시'], domain: 'stock' },
  { key: 'stock_us', label: '미국 증시 시황',
    terms: ['뉴욕증시', '나스닥', '미국 증시', '다우지수'], domain: 'stock' },
  { key: 'stock_issue', label: '증시 이슈 섹터',
    terms: ['테마주', '급등주', '수혜주', '증시 이슈'], domain: 'stock' },
];

const ALL_SECTIONS = [
  { key: 'breaking', label: '속보', terms: ['속보'], breaking: true },
  { key: 'logistics', label: '물류', terms: ['물류', '롯데글로벌로지스'], domain: 'logistics' },
  { key: 'economy', label: '경제', terms: ['경제 금리'], domain: 'economy' },
  { key: 'society', label: '정치/사회', terms: ['정치', '국회', '사건사고'], domain: 'society' },
  { key: 'global', label: '글로벌', terms: ['국제'], domain: 'global' },
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

async function fetchBreaking(limit = 10) {
  // 엄격 필터라 후보를 넉넉히 받아온 뒤 걸러낸다
  const raw = await searchByTerms(['속보'], { display: 30, sort: 'date', verify: false });
  return raw.filter(isBreakingItem).slice(0, limit);
}

// /api/breaking : 프런트 '속보' 카테고리 전용
app.get('/api/breaking', async (req, res) => {
  const limit = Math.min(Number(req.query.display) || 20, 50);
  try {
    res.json({ items: await fetchBreaking(limit) });
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

  try {
    let items = [];
    let used = steps[0];
    for (const s of steps) {
      items = await searchByTerms(terms, {
        display: limit,
        sort,
        hours: s.hours,
        verify: false,   // [A] 사용자가 직접 친 키워드는 원문 검증 생략
        match: s.match,
        expand: true,    // [F] 동의어 확장
        fetchCount: 100, // [D] 최대치로 받아온 뒤 추림
      });
      used = s;
      if (items.length) break;
    }

    res.json({
      items: items.slice(0, limit),
      mode,
      terms,
      relaxed: used.note,                 // 조건을 완화했다면 안내 문구용
      requested: hoursText(reqH),
      total: items.length,
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

function titleTokens(title) {
  return (title || '')
    .replace(/[^\uAC00-\uD7A3A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// 두 기사 제목이 얼마나 겹치는지 (0~1)
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

app.get('/api/briefing', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 30);
  const { dateFrom, dateTo, hours } = req.query;

  try {
    // 1) 카테고리별로 따로 수집 (속보 쏠림 방지)
    const perCat = await Promise.all(
      BRIEFING_SOURCES.map(async (src) => {
        const items = src.cat === 'breaking'
          ? await fetchBreaking(10)
          : (await searchByTerms(src.terms, { display: 10, dateFrom, dateTo, hours, domain: src.domain })).slice(0, 10);
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
  const { dateFrom, dateTo, perSection = '5', hours } = req.query;
  const limit = Math.min(Number(perSection) || 5, 30);
  try {
    const sections = await Promise.all(
      ALL_SECTIONS.map(async (sec) => {
        const items = sec.breaking
          ? await fetchBreaking(limit)
          : (await searchByTerms(sec.terms, { display: limit, dateFrom, dateTo, hours, domain: sec.domain })).slice(0, limit);
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
    const { dateFrom, dateTo, perSection = '5', hours } = req.query;
    const limit = Math.min(Number(perSection) || 5, 30);
    try {
      const sections = await Promise.all(
        SECTIONS.map(async (sec) => {
          const items = await searchByTerms(sec.terms, { display: limit, dateFrom, dateTo, hours, domain: sec.domain });
          return { key: sec.key, label: sec.label, items: items.slice(0, limit) };
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

    const { dateFrom, dateTo, display = '20', hours } = req.query;
    try {
      const limit = Math.min(Number(display) || 20, 50);
      const items = await searchByTerms(sec.terms, { display: limit, dateFrom, dateTo, hours, domain: sec.domain });
      res.json({ items: items.slice(0, limit), label: sec.label });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
  });
}

registerSectionRoutes('logistics', LOGISTICS_SECTIONS);
registerSectionRoutes('stock', STOCK_SECTIONS);

// -----------------------------------------------------------------
// /api/article-summary?url=...&max=3 : 원문에서 핵심 문장만 추출
//  네이버 검색 API의 description은 원본이 "..."로 잘려 오므로,
//  원문 페이지 본문을 읽어 잡음(저작권/기자정보/SNS 안내)을 걸러내고
//  핵심 문장 max개만 반환한다.
// -----------------------------------------------------------------
const summaryCache = new Map(); // `${url}::${max}` -> { ts, sentences }
const SUMMARY_TTL = 1000 * 60 * 30;

// 기사 본문에 섞여 들어오는 잡음(저작권/기자정보/SNS 안내 등)
//   [확장] 목록성 문구도 추가 : 많이 본 / 관련기사 / 추천 / 이전·다음 기사 / 인기기사 등
const NOISE_PAT = /(무단\s?전재|재배포|저작권자|ⓒ|©|기자\s*=|구독|앱 다운로드|카카오톡|페이스북|네이버에서|사진=|영상=|제보|▶|많이\s?본|관련\s?기사|추천\s?기사|추천\s?뉴스|인기\s?기사|이전\s?기사|다음\s?기사|주요\s?뉴스|헤드라인|포토\s?뉴스|많이\s?읽은|함께\s?본)/;

// 제목에서 '핵심 단어'만 뽑는다 (조사·기호 제거, 2글자 이상만)
function keywordsFromTitle(title = '') {
  return String(title)
    .replace(/[^가-힣A-Za-z0-9\s]/g, ' ')   // 특수문자 제거
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 12);
}

// 본문에서 핵심 문장 max개만 추림
//   [개선] 무조건 앞 3문장이 아니라, 제목 핵심 단어가 들어간 문장을 우선으로 뽑는다.
function coreSentences(text, max = 3, title = '') {
  // 1) 잡음·길이 조건을 통과한 '깨끗한 문장' 후보를 순서대로 모은다
  const clean = [];
  for (const s of splitSummary(text)) {
    const t = s.trim();
    if (t.length < 20 || t.length > 250) continue; // 너무 짧거나 긴 문장 제외
    if (NOISE_PAT.test(t)) continue;
    if (clean.includes(t)) continue;
    clean.push(t);
  }

  // 2) 제목 핵심 단어가 몇 개 들어있는지로 점수를 매긴다 (많이 겹칠수록 위로)
  const keys = keywordsFromTitle(title);
  const scored = clean.map((t, i) => {
    const lower = t.toLowerCase();
    const hit = keys.filter((k) => lower.includes(k.toLowerCase())).length;
    return { t, i, hit };
  });

  // 3) 점수 높은 순 → 같으면 원문 등장 순서(앞쪽) 우선
  scored.sort((a, b) => (b.hit - a.hit) || (a.i - b.i));

  // 4) 상위 max개를 고르되, 최종 출력은 '원문에 나온 순서'로 정렬(자연스러운 읽기)
  const picked = scored.slice(0, max).sort((a, b) => a.i - b.i);
  return picked.map((x) => x.t);
}

function pickMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return '';
  return stripHtml(tag.match(/content=["']([\s\S]*?)["']/i)?.[1] || '');
}

app.get('/api/article-summary', async (req, res) => {
  const url = req.query.url;
  const max = Math.min(Math.max(Number(req.query.max) || 3, 1), 10);
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url이 필요합니다.' });

  const cacheKey = `${url}::${max}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUMMARY_TTL) return res.json({ sentences: cached.sentences });

  try {
    // [수정] 요약도 '본문 추출 고도화' 로직을 그대로 사용한다.
    //   (언론사 원문 → 네이버 뉴스 → 네이버 모바일 자동 재시도)
    const best = await fetchArticleTextSmart(url, req.query.naver, 300);

    // 유료/회원 전용 안내만 잔뜩 나온 경우
    if (/(유료\s?회원|회원\s?전용|구독자\s?전용|로그인\s?후\s?이용|subscribers?\s+only|paywall)/i.test(best.slice(0, 1000))) {
      return res.status(200).json({ sentences: [], error: 'paywall' });
    }

    const title = String(req.query.title || '');
    const desc = String(req.query.desc || '');

    let sentences = coreSentences(best, max, title);

    // [개선] 추출 품질이 낮으면(본문이 너무 짧거나 / 건진 문장이 1개 이하 /
    //   문장 총 길이가 빈약하면) 차라리 네이버 요약문을 우선 사용한다.
    const lowQuality =
      best.length < 400 || sentences.length < 2 || sentences.join('').length < 60;
    if (lowQuality && desc.trim().length >= 60) {
      const fromDesc = coreSentences(desc, max, title);
      if (fromDesc.length) sentences = fromDesc;
    }

    // 그래도 비었으면 네이버 요약문으로라도 만든다
    if (!sentences.length) sentences = coreSentences(desc, max, title);
    if (!sentences.length) throw new Error('본문 추출 실패');

    summaryCache.set(cacheKey, { ts: Date.now(), sentences });
    res.json({ sentences });
  } catch (err) {
    res.status(200).json({ sentences: [], error: err.message });
  }
});

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

[출력 형식] 아래 JSON만 출력. 다른 말 금지.
{
  "headline": "핵심을 담은 짧은 제목",
  "lead": "핵심을 3~4문장으로 요약한 문단",
  "table": [{ "key": "항목명", "value": "내용" }],
  "bullets": ["핵심 포인트 문장"]
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

// 후보 목록을 돌면서 '되는 모델'을 찾아 한 번 호출한다 (404는 다음 후보로)
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
      throw e; // 400 / 429 등은 모델 문제가 아니므로 위로 던진다
    }
  }
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
  const MAX_RETRY = 2; // 429일 때 최대 2번 더 시도
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await enqueueGemini(() => callGeminiModels(prompt));
    } catch (e) {
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
      return res.json({ error: '원문 본문을 읽지 못했습니다. 해당 언론사가 자동 수집을 막았을 수 있습니다. (원문보기로 확인해 주세요)' });
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

app.listen(PORT, () => {
  console.log(`네이버 뉴스 프록시 서버 실행 중: http://localhost:${PORT}`);
});
