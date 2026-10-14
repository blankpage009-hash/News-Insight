const fs=require('fs');const R='./';
for(const f of ['news-insight-naver.html','privacy.html']){
const t=fs.readFileSync(R+f,'utf8');
const defined=new Set();let m;
for(const re of [/\bfunction\s+([A-Za-z_$][\w$]*)/g,/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,/window\.([A-Za-z_$][\w$]*)\s*=/g]){while((m=re.exec(t)))defined.add(m[1]);}
const builtins=new Set(['event','this','if','return','document','window','location','history','Number','String','JSON','encodeURIComponent','alert','confirm','setTimeout','Math','arg','true','false','null','typeof','new','void']);
const used=new Map();
const hre=/\bon(click|change|input|submit|keydown|keyup|error|load|mouseenter|mouseleave|focus|blur|toggle|pointerdown|touchstart|scroll)\s*=\s*(["'])([\s\S]*?)\2/g;
while((m=hre.exec(t))){const code=m[3];const line=t.slice(0,m.index).split('\n').length;
 let c;const cre=/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;while((c=cre.exec(code))){if(!builtins.has(c[1]))used.set(c[1],(used.get(c[1])||[]).concat(line));}}
console.log('== '+f);
for(const [n,ls] of used){if(!defined.has(n))console.log('UNDEFINED',n,ls.slice(0,5).join(','));}
console.log('handler fn names:',used.size);}
