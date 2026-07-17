// server.js
// 네이버 검색 API(뉴스) 프록시 서버 - Naver API HUB 사용
//
// [이번 업데이트]
//  1) /api/briefing : 카테고리 균형(속보 쏠림 방지) 라운드로빈 선발
//  2) /api/article-summary : 원문 본문에서 잡음 제거 후 핵심 문장 N개(기본 2개)만 반환
//  3) /api/all/sections, /api/logistics/sections : perSection 파라미터로 노출 개수 조절
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
  return (data.items || []).map((item) => ({
    title: stripHtml(item.title),
    summary: splitSummary(stripHtml(item.description)),
    source: guessSource(item.originallink, item.link),
    url: item.originallink || item.link,
    datetime: toIsoDate(item.pubDate),
  }));
}

async function searchByTerms(terms, { display = 15, sort = 'date', dateFrom, dateTo } = {}) {
  const perTermDisplay = Math.max(10, Math.min(30, Number(display) || 15));

  const resultsPerTerm = await Promise.all(
    terms.map(async (term) => {
      try {
        const raw = await naverSearchRaw(term, perTermDisplay, sort);
        return raw.filter((it) => itemMatchesAnyTerm(it, [term]));
      } catch (e) {
        console.error(`[검색 실패] "${term}":`, e.message);
        return [];
      }
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

  merged.sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
  return merged;
}

// -----------------------------------------------------------------
// 카테고리 설정
// -----------------------------------------------------------------
const LOGISTICS_SECTIONS = [
  { key: 'logistics_lotte', label: '롯데글로벌로지스', terms: ['롯데글로벌로지스'] },
  {
    key: 'logistics_competitor',
    label: '경쟁사',
    terms: ['CJ대한통운', '한진', 'LX판토스', '삼성SDS', '현대글로비스'],
  },
  { key: 'logistics_domestic', label: '국내 물류', terms: ['국내 물류', '국내물류'] },
  { key: 'logistics_global', label: '글로벌 물류', terms: ['글로벌 물류', '해외 물류', '국제 물류'] },
];

const ALL_SECTIONS = [
  { key: 'breaking', label: '속보', terms: ['속보'] },
  { key: 'logistics', label: '물류', terms: ['물류', '롯데글로벌로지스'] },
  { key: 'economy', label: '경제', terms: ['경제 금리'] },
  { key: 'society', label: '사회', terms: ['사건사고'] },
  { key: 'global', label: '글로벌', terms: ['국제'] },
  { key: 'stock', label: '증시', terms: ['증시 코스피'] },
];

// -----------------------------------------------------------------
// /api/news
// -----------------------------------------------------------------
app.get('/api/news', async (req, res) => {
  const { q, display = '20', sort = 'date', dateFrom, dateTo } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: '검색어(q)가 필요합니다.' });

  try {
    const limit = Math.min(Number(display) || 20, 50);
    const items = await searchByTerms([q.trim()], { display: limit, sort, dateFrom, dateTo });
    res.json({ items: items.slice(0, limit) });
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
  { cat: 'economy', terms: ['경제 금리', '환율'] },
  { cat: 'stock', terms: ['증시 코스피'] },
  { cat: 'logistics', terms: ['물류'] },
  { cat: 'society', terms: ['사건사고'] },
  { cat: 'global', terms: ['국제'] },
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
  const { dateFrom, dateTo } = req.query;

  try {
    // 1) 카테고리별로 따로 수집 (속보 쏠림 방지)
    const perCat = await Promise.all(
      BRIEFING_SOURCES.map(async (src) => {
        const items = await searchByTerms(src.terms, { display: 10, dateFrom, dateTo });
        return items.slice(0, 10).map((it) => ({ ...it, cat: src.cat }));
      })
    );

    const seen = new Set();
    const pool = perCat.flat().filter((it) => {
      if (!it.url || seen.has(it.url)) return false;
      seen.add(it.url);
      return true;
    });
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
  const { dateFrom, dateTo, perSection = '5' } = req.query;
  const limit = Math.min(Number(perSection) || 5, 30);
  try {
    const sections = await Promise.all(
      ALL_SECTIONS.map(async (sec) => {
        const items = await searchByTerms(sec.terms, { display: limit, dateFrom, dateTo });
        return { key: sec.key, label: sec.label, items: items.slice(0, limit) };
      })
    );
    res.json({ sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/logistics/sections
// -----------------------------------------------------------------
app.get('/api/logistics/sections', async (req, res) => {
  const { dateFrom, dateTo, perSection = '5' } = req.query;
  const limit = Math.min(Number(perSection) || 5, 30);
  try {
    const sections = await Promise.all(
      LOGISTICS_SECTIONS.map(async (sec) => {
        const items = await searchByTerms(sec.terms, { display: limit, dateFrom, dateTo });
        return { key: sec.key, label: sec.label, items: items.slice(0, limit) };
      })
    );
    res.json({ sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/logistics/section/:key
// -----------------------------------------------------------------
app.get('/api/logistics/section/:key', async (req, res) => {
  const sec = LOGISTICS_SECTIONS.find((s) => s.key === req.params.key);
  if (!sec) return res.status(404).json({ error: '존재하지 않는 카테고리입니다.' });

  const { dateFrom, dateTo, display = '20' } = req.query;
  try {
    const limit = Math.min(Number(display) || 20, 50);
    const items = await searchByTerms(sec.terms, { display: limit, dateFrom, dateTo });
    res.json({ items: items.slice(0, limit), label: sec.label });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// -----------------------------------------------------------------
// /api/article-summary?url=...&max=2 : 원문에서 핵심 문장만 추출
//  네이버 검색 API의 description은 원본이 "..."로 잘려 오므로,
//  원문 페이지 본문을 읽어 잡음(저작권/기자정보/SNS 안내)을 걸러내고
//  핵심 문장 max개만 반환한다.
// -----------------------------------------------------------------
const summaryCache = new Map(); // `${url}::${max}` -> { ts, sentences }
const SUMMARY_TTL = 1000 * 60 * 30;

// 기사 본문에 섞여 들어오는 잡음(저작권/기자정보/SNS 안내 등)
const NOISE_PAT = /(무단\s?전재|재배포|저작권자|ⓒ|©|기자\s*=|구독|앱 다운로드|카카오톡|페이스북|네이버에서|사진=|영상=|제보|▶)/;

// "...", "…" 처럼 잘린 흔적
const ELLIPSIS_PAT = /(\.{2,}|…)\s*$/;

// 문장이 끝까지 완성됐는지 판단
function isCompleteSentence(t) {
  if (ELLIPSIS_PAT.test(t)) return false;          // 잘린 문장 제외
  return /[.!?]["'’”)\]]?$/.test(t);              // 마침표/물음표/느낌표로 끝나야 통과
}

// 본문에서 핵심 문장 max개만 추림 (완성된 문장만)
function coreSentences(text, max = 2) {
  const out = [];
  for (const s of splitSummary(text)) {
    const t = s.trim();
    if (t.length < 20 || t.length > 250) continue; // 너무 짧거나 긴 문장 제외
    if (NOISE_PAT.test(t)) continue;
    if (!isCompleteSentence(t)) continue;          // ★ 핵심: 잘린 문장 스킵
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// 본문 영역을 찾아 텍스트로 뽑아냄
function extractBodyText(html) {
  const starters = [
    /<div[^>]+id=["'](?:dic_area|newsct_article|articleBodyContents|articeBody|article_body|newsEndContents|articleBody)["'][^>]*>/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:article_body|news_body|art_text|article-body|entry-content|post-content|article_view)[^"']*["'][^>]*>/i,
    /<article[^>]*>/i,
  ];
  for (const re of starters) {
    const m = html.match(re);
    if (m && m.index != null) {
      // 여는 태그 위치부터 넉넉히 잘라서 태그만 제거 (중첩 div 문제 회피)
      const text = stripHtml(html.slice(m.index, m.index + 12000));
      if (text.length > 200) return text.slice(0, 4000);
    }
  }
  return '';
}

function pickMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return '';
  return stripHtml(tag.match(/content=["']([\s\S]*?)["']/i)?.[1] || '');
}

app.get('/api/article-summary', async (req, res) => {
  const url = req.query.url;
  const max = Math.min(Math.max(Number(req.query.max) || 2, 1), 10);
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url이 필요합니다.' });

  const cacheKey = `${url}::${max}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUMMARY_TTL) return res.json({ sentences: cached.sentences });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept-Language': 'ko,en;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const html = await r.text();

    // 본문 후보 영역 우선
    const bodyText = extractBodyText(html);
    const meta = pickMeta(html, 'og:description') || pickMeta(html, 'description');

    const best = bodyText.length > meta.length ? bodyText : meta;
    let sentences = coreSentences(best, max);
    if (!sentences.length) sentences = coreSentences(meta, max);
    if (!sentences.length) throw new Error('본문 추출 실패');

    summaryCache.set(cacheKey, { ts: Date.now(), sentences });
    res.json({ sentences });
  } catch (err) {
    res.status(200).json({ sentences: [], error: err.message });
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
