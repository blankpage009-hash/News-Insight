// 두 파일이 같은 값을 가져야 하는 제외어 쌍 비교 (읽기만)
const fs = require('fs');
const R = './';
const h = fs.readFileSync(R + 'news-insight-naver.html', 'utf8');
const s = fs.readFileSync(R + 'server.js', 'utf8');
const arr = (src, re) => { const m = re.exec(src); return m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null; };
const html = {
  logistics: arr(h, /const LOGI_EXCLUDE = \[([^\]]*)\]/),
  stock: arr(h, /const STOCK_EXCLUDE = \[([^\]]*)\]/),
  sports: arr(h, /const SPORTS_EXCLUDE = \[([^\]]*)\]/),
};
// 서버 DOMAINS 블록에서 도메인별 exclude 배열
const start = s.indexOf('const DOMAINS');
const block = s.slice(start, start + 20000);
for (const d of Object.keys(html)) {
  const m = new RegExp(String.raw`\n\s*` + d + String.raw`:\s*\{[\s\S]*?exclude:\s*\[([^\]]*)\]`).exec(block);
  const srv = m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
  const a = new Set(html[d] || []), b = new Set(srv || []);
  const onlyH = [...a].filter((x) => !b.has(x)), onlyS = [...b].filter((x) => !a.has(x));
  console.log(d, 'html', a.size, 'server', srv ? b.size : '못 찾음', onlyH.length || onlyS.length ? `화면만:${onlyH} / 서버만:${onlyS}` : '일치');
}
console.log('DOMAINS 위치 줄', s.slice(0, start).split('\n').length);
