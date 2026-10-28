const { chromium, devices } = require('playwright');
const fs=require('fs');
function env(){const raw=fs.readFileSync('.env.local','utf-8');const o={};for(const l of raw.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m)o[m[1]]=m[2].replace(/^["']|["']$/g,'');}return o;}
async function sesion(){const {SUPABASE_KEY}=env();
 const r=await fetch('https://dfcfimipkfhitlsyixqu.supabase.co/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:'admin@demo.com',password:'demo123'})});
 const d=await r.json(); const p=JSON.parse(Buffer.from(d.access_token.split('.')[1],'base64url').toString()); const meta=p.user_metadata||{};
 return {t:d.access_token, rf:d.refresh_token, u:{id:p.sub,nombre:meta.nombre||'demo',email:p.email,rol:meta.rol||'admin',tenant_id:meta.tenant_id}};}
(async()=>{
 const s=await sesion();
 const b=await chromium.launch();
 for (const [nombre,dev] of [['iphone',devices['iPhone 13']],['pc',{viewport:{width:1280,height:800}}]]) {
  const ctx=await b.newContext({...dev,locale:'es-CL'});
  await ctx.addInitScript(([t,rf,u])=>{localStorage.setItem('agendapro_access_token',t);localStorage.setItem('agendapro_refresh_token',rf);localStorage.setItem('agendapro_user_data',JSON.stringify(u));
   try{const pl=JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));localStorage.setItem('sb-dfcfimipkfhitlsyixqu-auth-token',JSON.stringify({access_token:t,refresh_token:rf,token_type:'bearer',expires_in:3600,expires_at:pl.exp,user:{id:u.id,email:u.email,user_metadata:{nombre:u.nombre,rol:u.rol,tenant_id:u.tenant_id}}}));}catch(e){}
  },[s.t,s.rf,s.u]);
  const page=await ctx.newPage();
  page.on('pageerror',e=>console.log('PAGEERROR',e.message));
  await page.goto('https://agenda-pro-red.vercel.app/ventas-live.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.getElementById('vl-content') && getComputedStyle(document.getElementById('vl-content')).display!=='none',{timeout:40000}).catch(()=>{});
  await page.waitForTimeout(1500);
  // abrir el cajón de conversaciones desde el LIVE
  await page.click('#lv-chat-conv').catch(async()=>{ await page.click('.vl-tab[data-view="procesos"]'); });
  await page.waitForTimeout(2500);
  const info=await page.evaluate(()=>{
    const btn=document.getElementById('vld-pagos');
    const chips=[...document.querySelectorAll('.vl-conv-item .vl-conv-chip')].map(e=>e.textContent.trim());
    return {pagosBtn: btn? {abierto:getComputedStyle(btn).display!=='none', texto:btn.textContent.trim(), activo:btn.classList.contains('activo')}:null,
            chips, items:document.querySelectorAll('.vl-conv-item').length};
  });
  console.log(`[${nombre}] botón pagos:`, JSON.stringify(info.pagosBtn), '· items:', info.items, '· chips:', info.chips.join(' | '));
  // activar el filtro
  if (info.pagosBtn && info.pagosBtn.abierto) {
    await page.click('#vld-pagos'); await page.waitForTimeout(900);
    const tras=await page.evaluate(()=>({items:document.querySelectorAll('.vl-conv-item').length,
      chips:[...document.querySelectorAll('.vl-conv-item .vl-conv-chip')].map(e=>e.textContent.trim())}));
    console.log(`[${nombre}] tras filtrar → items:`, tras.items, '· chips:', tras.chips.join(' | '));
  }
  await page.screenshot({path:`e2e-shots/vl23/chat-pagos-${nombre}.png`});
  await ctx.close();
 }
 await b.close();
})();
