const fs=require('fs');
const L=fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/);
const starts=[];L.forEach((l,i)=>{if(/app\.(get|post|put|delete)\(/.test(l)||/^(async )?function \w+\(.*req/.test(l))starts.push(i)});
starts.push(L.length);
for(let k=0;k<starts.length-1;k++){
  const s=starts[k],e=starts[k+1];const found=new Set();
  for(let i=s;i<e;i++){const l=L[i];
    let m;const re=/req\.(query|body|params)\.(\w+)/g;while((m=re.exec(l)))found.add(m[1]+'.'+m[2]);
    const d=/\{([^}]*)\}\s*=\s*req\.(query|body|params)/.exec(l);if(d)d[1].split(',').forEach(x=>{x=x.trim().split(/[=:\s]/)[0];if(x)found.add(d[2]+'.'+x)});
    const q=/(\w+)\s*=\s*req\.(query|body)\b(?!\.)/.exec(l);if(q)found.add(q[2]+' as '+q[1]);
  }
  console.log((s+1)+': '+L[s].trim().slice(0,70)+'\n    '+[...found].join(' '));
}
