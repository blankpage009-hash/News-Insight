const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
console.log(b({alg:'none'})+'.'+b({exp:Math.floor(Date.now()/1000)+36000})+'.x');
