// 단계 3 시험용 가짜 Supabase (fake-supabase.js 와 같은 응답 + 기록 기능)
// 실행 : FAKE_PORT=54321 FAKE_LOG=<기록 파일> node docs/review/tools/fake-supabase-log.js
// - POST 본문마다 : 바이트 수 · JSON.parse 성공 여부 · 짝 없는 서로게이트 이스케이프 수 · \u0000 수 · U+FFFD 수
// - JSON.parse 가 실패하면 실제 PostgREST 처럼 400 PGRST102 를 돌려준다
// - GET /__dump : 저장된 열쇠별 바이트 수
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
// 기록 파일이 저장소 안에 쌓이지 않도록 기본값은 임시 폴더
const LOG = process.env.FAKE_LOG || path.join(os.tmpdir(), 'fake-supabase.log');
const PORT = Number(process.env.FAKE_PORT || 54321);
const store = new Map();

function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

// 원문(JSON 텍스트) 안의 \uD800-\uDFFF 이스케이프 중 짝이 안 맞는 것
function countLoneSurrogateEscapes(text) {
  const re = /\\u([dD][89abAB][0-9a-fA-F]{2})(\\u[dD][c-fC-F][0-9a-fA-F]{2})?|\\u[dD][c-fC-F][0-9a-fA-F]{2}/g;
  let lone = 0, m;
  while ((m = re.exec(text))) {
    if (m[1] && m[2]) continue;
    lone++;
  }
  return lone;
}

http.createServer((q, r) => {
  const chunks = [];
  q.on('data', c => chunks.push(c));
  q.on('end', () => {
    const buf = Buffer.concat(chunks);
    const b = buf.toString('utf8');
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/__dump') {
      r.setHeader('content-type', 'application/json');
      const out = {};
      for (const [k, v] of store) out[k] = Buffer.byteLength(JSON.stringify(v));
      return r.end(JSON.stringify(out));
    }
    if (u.pathname === '/auth/v1/user') {
      r.setHeader('content-type', 'application/json');
      return r.end(JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', email: 'tester@example.test', email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { name: 'Tester' } }));
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      const t = u.pathname.slice(9);
      r.setHeader('content-type', 'application/json');
      if (q.method === 'GET') {
        const k = u.searchParams.get('key');
        log({ method: 'GET', table: t, query: u.search });
        if (t === 'app_settings' && k) {
          const v = store.get(k.replace('eq.', ''));
          return r.end(JSON.stringify(v === undefined ? [] : [{ value: v }]));
        }
        return r.end('[]');
      }
      const info = {
        method: q.method, table: t, query: u.search,
        contentType: q.headers['content-type'] || null,
        contentLength: q.headers['content-length'] || null,
        transferEncoding: q.headers['transfer-encoding'] || null,
        bytes: buf.length,
        loneSurrogateEscapes: countLoneSurrogateEscapes(b),
        nulEscapes: (b.match(/\\u0000/g) || []).length,
        replacementChars: (b.match(/�/g) || []).length,
      };
      let parsed;
      try { parsed = b.length ? JSON.parse(b) : undefined; info.jsonOk = parsed !== undefined; }
      catch (e) { info.jsonOk = false; info.jsonError = String(e.message).slice(0, 200); }
      if (parsed !== undefined) {
        info.keys = [].concat(parsed).map(row => row && row.key).filter(Boolean);
        if (q.method === 'POST' && t === 'app_settings') {
          for (const row of [].concat(parsed)) store.set(row.key, row.value);
        }
      }
      log(info);
      if (!info.jsonOk && q.method !== 'DELETE') {
        r.statusCode = 400;
        return r.end(JSON.stringify({ code: 'PGRST102', details: null, hint: null, message: 'Empty or invalid json' }));
      }
      r.statusCode = q.method === 'POST' ? 201 : 204;
      return r.end();
    }
    r.statusCode = 404; r.end('{}');
  });
}).listen(PORT, '127.0.0.1', () => console.log('fake supabase (log) :' + PORT + ' → ' + LOG));
