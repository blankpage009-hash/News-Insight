// 1단계 재점검용 : 글자 그대로 검색으로 (1) 한 번만 나오는 이름 (2) 자기 몸통 안에서만 불리는 함수 (3) 쓰기만 하고 읽지 않는 변수
const fs = require('fs');
const R = './';
const files = ['server.js', 'news-insight-naver.html', 'privacy.html',
  ...fs.readdirSync(R + 'docs').filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)];
const txt = {};
files.forEach((f) => { txt[f] = fs.readFileSync(R + f, 'utf8'); });
const esc = (s) => s.replace(/[$]/g, '\\$');
const wordRe = (n, flags = 'g') => new RegExp(String.raw`(?<![\w$])` + esc(n) + String.raw`(?![\w$])`, flags);
const lineOf = (t, i) => t.slice(0, i).split('\n').length;
const stripLineComments = (t) => t.split('\n').map((l) => l.replace(/(^|[\s;,(){}])\/\/.*$/, '$1')).join('\n');

for (const f of ['server.js', 'news-insight-naver.html']) {
  const t = txt[f];
  const code = stripLineComments(t);
  const names = new Map();
  let m;
  for (const re of [/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]/g]) {
    while ((m = re.exec(t))) if (!names.has(m[1]) && m[1].length > 2) names.set(m[1], lineOf(t, m.index));
  }
  const once = [], onlyComments = [], writeOnly = [];
  for (const [n, line] of names) {
    const all = files.reduce((s, g) => s + (txt[g].match(wordRe(n)) || []).length, 0);
    if (all <= 1) once.push(`${f}:${line} ${n}`);
    const inCode = (stripLineComments(txt['server.js']) + stripLineComments(txt['news-insight-naver.html'])).match(wordRe(n)) || [];
    if (all > 1 && inCode.length <= 1) onlyComments.push(`${f}:${line} ${n} (전체 ${all}, 코드 ${inCode.length})`);
    // 읽기 횟수 : 대입 왼쪽(= += ++ 등)이 아닌 등장
    const rr = new RegExp(String.raw`(?<![\w$])` + esc(n) + String.raw`(?![\w$])`, 'g');
    let x, reads = 0;
    while ((x = rr.exec(code))) {
      const after = code.slice(x.index + n.length, x.index + n.length + 4);
      const before = code.slice(Math.max(0, x.index - 6), x.index);
      const isWrite = /^\s*(=(?!=)|\+=|-=|\|\|=|&&=|\?\?=|\+\+|--)/.test(after) || /(\+\+|--)\s*$/.test(before);
      const isDecl = /\b(let|var|const|function\s*\*?)\s*$/.test(before + ' ') || /(let|var|const)\s+$/.test(code.slice(Math.max(0, x.index - 8), x.index));
      if (!isWrite && !isDecl) reads++;
    }
    if (reads === 0 && all > 1) writeOnly.push(`${f}:${line} ${n}`);
  }
  console.log(`== ${f} : 이름 ${names.size}개`);
  console.log(' [한 번만 나옴]', once.join(' | ') || '없음');
  console.log(' [코드에선 선언뿐(주석·문서에만 나옴)]', onlyComments.join(' | ') || '없음');
  console.log(' [쓰기만 하고 읽지 않음]', writeOnly.join(' | ') || '없음');

  // 자기 몸통 안에서만 불리는 함수
  const selfOnly = [];
  const fre = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fre.exec(t))) {
    const name = m[1];
    let j = t.indexOf('{', m.index), d = 0;
    for (; j < t.length; j++) { if (t[j] === '{') d++; else if (t[j] === '}' && !--d) break; }
    const outside = t.slice(0, m.index) + t.slice(j + 1);
    if (!(outside.match(wordRe(name)) || []).length) selfOnly.push(`${f}:${lineOf(t, m.index)} ${name}`);
  }
  console.log(' [자기 몸통 밖에서 안 불림]', selfOnly.join(' | ') || '없음');
}
