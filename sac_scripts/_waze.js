const https = require('https');
function get(url) { return new Promise((res, rej) => { https.get(url, { headers: { 'User-Agent':'Mozilla/5.0 ... Chrome/120 Safari/537.36', Referer:'https://www.waze.com/es/live-map/' } }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(d)); }).on('error', rej); }); }
async function waze(q){ const u='https://www.waze.com/row-SearchServer/mozi?q='+encodeURIComponent(q)+'&lang=es&origin=livemap&lon=-74.8070&lat=10.9685&v=7773'; try{ const j=JSON.parse(await get(u)); return j.slice(0,2).map(x=>x.name); }catch(e){ return ['ERR '+e.message]; } }
(async()=>{
  // misma dirección 3 veces (consistencia)
  for (let i=1;i<=3;i++){ console.log('intento '+i+':', JSON.stringify(await waze('CL 28 22 18, Barranquilla, Atlantico'))); await new Promise(r=>setTimeout(r,500)); }
})();
