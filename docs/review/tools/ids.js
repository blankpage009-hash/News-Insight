const fs=require('fs');const t=fs.readFileSync('./news-insight-naver.html','utf8');
const ids=new Set();let m;const re=/\bid\s*=\s*["'`]([^"'`$]+)["'`]/g;while((m=re.exec(t)))ids.add(m[1]);
const re3=/\.id\s*=\s*['"`]([^'"`$]+)/g;while((m=re3.exec(t)))ids.add(m[1]);
const miss=new Map();const re2=/getElementById\(\s*['"]([^'"]+)['"]\s*\)|querySelector(?:All)?\(\s*['"]#([\w-]+)/g;
while((m=re2.exec(t))){const id=m[1]||m[2];if(!ids.has(id)){const l=t.slice(0,m.index).split('\n').length;miss.set(id,(miss.get(id)||[]).concat(l));}}
for(const [k,v] of miss)console.log(k,v.join(','));
// id 는 있는데 JS 에서 한 번도 안 찾는 것(정보용)
