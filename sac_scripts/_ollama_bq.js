const http=require('http');
function chat(prompt){return new Promise((res,rej)=>{const body=JSON.stringify({model:'qwen2.5:3b',messages:[{role:'user',content:prompt}],stream:false,options:{temperature:0}});const req=http.request({hostname:'localhost',port:11434,path:'/api/chat',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:120000},r=>{let d='';r.on('data',x=>d+=x);r.on('end',()=>{try{resolve_(JSON.parse(d))}catch(e){rej(e)}});});var resolve_=res;req.on('error',rej);req.write(body);req.end();});}
(async()=>{
  const barrios=['Simón Bolívar','El Bosque','Riomar','Paraíso','El Prado','Rebolo','La Pradera','Boston','Los Andes','Carrizal'];
  const prompt='Barranquilla (Colombia) divide sus juzgados de pequeñas causas en 3 localidades de reparto: NORTE, SUR OCCIDENTE, SUR ORIENTE. Clasifica cada barrio en su localidad. Responde SOLO JSON {\"barrio\":\"NORTE|SUR OCCIDENTE|SUR ORIENTE\"}. Barrios: '+barrios.join(', ');
  const r=await chat(prompt);
  console.log(r.message?.content||JSON.stringify(r).substring(0,200));
})();
