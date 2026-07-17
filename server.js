// server.js
// 네이버 검색 API(뉴스) 프록시 서버 - Naver API HUB 사용
//
// [이번 업데이트]
//  1) /api/briefing : 현재 가장 이슈가 되는 뉴스 N건(기본 5건) 추림 (이슈 스코어링)
//  2) /api/all/sections, /api/logistics/sections : perSection 파라미터로 노출 개수 조절
//  3) /api/article-summary : 원문 페이지 메타/본문을 읽어 잘린 요약을 보강
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
// /api/briefing : 현재 가장 이슈가 되는 뉴스 N건
//  - 여러 축(속보/경제/증시/물류/사회/국제)에서 최신 기사를 모은 뒤
//  - '보도량(같은 토픽을 여러 매체가 다룸)' + '최신성'으로 이슈 스코어 산출
// -----------------------------------------------------------------
const BRIEFING_TERMS = ['속보', '단독', '경제', '증시', '물류', '사건사고', '국제'];
const STOPWORDS = new Set(['그리고', '하지만', '이번', '위해', '통해', '대한', '관련', '기자', '뉴스', '속보', '단독']);

function titleTokens(title) {
  return (title || '')
    .replace(/[^\uAC00-\uD7A3A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

app.get('/api/briefing', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 30);
  const { dateFrom, dateTo } = req.query;

  try {
    const pool = await searchByTerms(BRIEFING_TERMS, { display: 15, dateFrom, dateTo });
    if (!pool.length) return res.json({ items: [] });

    // 토큰 빈도 = 화제성
    const freq = new Map();
    pool.forEach((it) => {
      new Set(titleTokens(it.title)).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1));
    });

    const now = Date.now();
    const scored = pool.map((it) => {
      const tokens = [...new Set(titleTokens(it.title))];
      const buzz = tokens.reduce((s, t) => s + Math.max(0, (freq.get(t) || 1) - 1), 0);
      const ageHr = it.datetime ? (now - new Date(it.datetime).getTime()) / 3600000 : 48;
      const recency = Math.max(0, 24 - ageHr) / 24; // 최근 24시간 가중
      return { it, score: buzz + recency * 6, key: tokens.slice(0, 2).join('|') };
    });

    scored.sort((a, b) => b.score - a.score);

    // 유사 토픽 중복 제거
    const picked = [];
    const usedKeys = new Set();
    for (const s of scored) {
      if (s.key && usedKeys.has(s.key)) continue;
      usedKeys.add(s.key);
      picked.push(s.it);
      if (picked.length >= limit) break;
    }

    res.json({ items: picked });
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
// /api/article-summary?url=... : 원문에서 더 긴 요약 확보
//  네이버 검색 API의 description은 원본이 "..."로 잘려 오므로,
//  원문 페이지의 og:description / 본문 앞부분을 읽어 보강한다.
// -----------------------------------------------------------------
const summaryCache = new Map(); // url -> { ts, sentences }
const SUMMARY_TTL = 1000 * 60 * 30;

function pickMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return '';
  return stripHtml(tag.match(/content=["']([\s\S]*?)["']/i)?.[1] || '');
}

app.get('/api/article-summary', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url이 필요합니다.' });

  const cached = summaryCache.get(url);
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
    const bodyBlock =
      html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<div[^>]+(?:id|class)=["'][^"']*(?:article|news_?body|content|entry)[^"']*["'][\s\S]*?<\/div>/i)?.[0] ||
      '';

    const bodyText = stripHtml(bodyBlock).slice(0, 3000);
    const meta = pickMeta(html, 'og:description') || pickMeta(html, 'description');

    const best = bodyText.length > meta.length ? bodyText : meta;
    if (!best) throw new Error('본문 추출 실패');

    const sentences = splitSummary(best).slice(0, 30);
    summaryCache.set(url, { ts: Date.now(), sentences });
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
