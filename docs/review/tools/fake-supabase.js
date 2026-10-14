// 시험용 가짜 Supabase : 로그인 확인 + 빈 표. 저장소 밖(스크래치패드)에만 둔다.
const http=require('http');const store=new Map();
http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{
 const u=new URL(q.url,'http://x');
 if(u.pathname==='/auth/v1/user'){r.setHeader('content-type','application/json');
  return r.end(JSON.stringify({id:'00000000-0000-0000-0000-000000000001',email:'tester@example.test',email_confirmed_at:'2026-01-01T00:00:00Z',app_metadata:{provider:'google',providers:['google']},user_metadata:{name:'Tester'}}));}
 if(u.pathname.startsWith('/rest/v1/')){const t=u.pathname.slice(9);r.setHeader('content-type','application/json');
  if(q.method==='GET'){const k=u.searchParams.get('key');if(t==='app_settings'&&k){const v=store.get(k.replace('eq.',''));return r.end(JSON.stringify(v===undefined?[]:[{value:v}]));}return r.end('[]');}
  if(q.method==='POST'&&t==='app_settings'){try{for(const row of [].concat(JSON.parse(b)))store.set(row.key,row.value)}catch{}}
  r.statusCode=q.method==='POST'?201:204;return r.end();}
 r.statusCode=404;r.end('{}');});}).listen(54321,'127.0.0.1',()=>console.log('fake supabase :54321'));
