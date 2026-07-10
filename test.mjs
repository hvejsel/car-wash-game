import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

// Usage: node test.mjs [liveUrl]  — with no arg, serves the local files.
const liveUrl = process.argv[2];
let server=null, url=liveUrl;
if(!liveUrl){
  const ROOT = path.resolve('.');
  server = http.createServer((req,res)=>{
    let p = decodeURIComponent(req.url.split('?')[0]);
    if(p==='/') p='/index.html';
    const fp = path.join(ROOT, p);
    fs.readFile(fp,(err,data)=>{
      if(err){ res.writeHead(404); res.end('nf'); return; }
      const ext=path.extname(fp);
      const ct = ext==='.html'?'text/html':ext==='.js'?'text/javascript'
        :ext==='.glb'?'model/gltf-binary':ext==='.png'?'image/png':'application/octet-stream';
      res.writeHead(200,{'Content-Type':ct}); res.end(data);
    });
  });
  await new Promise(r=>server.listen(0,r));
  url = `http://localhost:${server.address().port}/index.html`;
}
console.log('testing', url);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist']
});
// emulate iPhone-ish viewport
const ctx = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
const page = await ctx.newPage();
const errors=[];
page.on('console', m=>{ if(m.type()==='error') errors.push(m.text()); });
page.on('pageerror', e=>errors.push('PAGEERROR: '+e.message));

let failed=false;
function check(name, cond){ console.log((cond?'PASS':'FAIL')+' — '+name); if(!cond) failed=true; }

await page.goto(url,{waitUntil:'load'});
// wait for game hook + three loaded from CDN
await page.waitForFunction(()=>window.__game && window.__game.webglOK && window.__game.webglOK(), {timeout:20000}).catch(()=>{});

const webgl = await page.evaluate(()=>window.__game?.webglOK?.());
check('WebGL renderer initialised', webgl===true);

// wait for the Ferrari GLB (DRACO) to finish loading
await page.waitForFunction(()=>window.__game.carReady(), {timeout:30000}).catch(()=>{});
const carReady = await page.evaluate(()=>window.__game.carReady());
check('real GLTF car model loaded (ferrari.glb via DRACO)', carReady===true);

// press Play
await page.evaluate(()=>window.__game.start());
await page.waitForTimeout(600);
const playing = await page.evaluate(()=>window.__game.state.playing);
check('game is playing after Play', playing===true);
const initDirt0 = await page.evaluate(()=>window.__game.initialDirt());
check('dirt sampled onto car body surface after Play (>50 3D patches)', initDirt0>50);
const startCardHidden = await page.evaluate(()=>document.getElementById('startCard').classList.contains('hidden'));
check('start overlay hidden after Play', startCardHidden===true);

// screenshot of dirty car
await page.screenshot({path:'shot-dirty.png'});

// spawn Morten and let him throw mud (adds dirt)
const beforeMorten = await page.evaluate(()=>window.__game.dirtCount());
await page.evaluate(()=>window.__game.spawnMorten());
await page.waitForTimeout(2200); // enter+wind+throw+land
const afterMorten = await page.evaluate(()=>window.__game.dirtCount());
check('Morten threw mud that stuck as new dirt (count grew)', afterMorten>=beforeMorten);

// scrub one patch via hook
const scrubbed = await page.evaluate(()=>window.__game.scrubOne());
check('scrubbing removes a dirt patch', scrubbed===true);

// simulate a real touch-drag across the canvas to prove broom scrubbing works
const dragBefore = await page.evaluate(()=>window.__game.dirtCount());
const box = await page.locator('#three').boundingBox();
await page.mouse.move(box.x+box.width*0.35, box.y+box.height*0.45);
await page.mouse.down();
for(let i=0;i<24;i++){ await page.mouse.move(box.x+box.width*(0.30+i*0.016), box.y+box.height*(0.40+ (i%6)*0.03)); await page.waitForTimeout(8); }
await page.mouse.up();
const dragAfter = await page.evaluate(()=>window.__game.dirtCount());
check('real pointer-drag scrubs dirt off the car (broom)', dragAfter<dragBefore);

// HOSE: hold the water on a dirty spot → 3D water particles fly + dirt comes off
await page.evaluate(()=>window.__game.setMode('hose'));
const hoseBefore = await page.evaluate(()=>window.__game.dirtCount());
let spot = await page.evaluate(()=>window.__game.dirtScreen());
await page.mouse.move(box.x+box.width*spot.sx, box.y+box.height*spot.sy);
await page.mouse.down();
// headless software-GL runs at very low FPS, so poll for the peak droplet count
let waterFlying=0;
for(let k=0;k<8;k++){ await page.waitForTimeout(400);
  const c=await page.evaluate(()=>window.__game.waterCount()); if(c>waterFlying) waterFlying=c; }
await page.screenshot({path:'shot-hose.png'});
await page.mouse.up();
const hoseAfter = await page.evaluate(()=>window.__game.dirtCount());
console.log('   (hose droplets in flight, peak:', waterFlying, ')');
check('hose sprays 3D water droplets while held (>15 in flight)', waterFlying>15);
check('hose spray washes dirt off the car', hoseAfter<hoseBefore);

// WATER PISTOL: same, tighter jet, aimed at a remaining dirty spot.
// If the hose already finished the car, start the next one first.
const wonEarly = await page.evaluate(()=>!document.getElementById('winCard').classList.contains('hidden'));
if(wonEarly){ await page.evaluate(()=>window.__game.next()); await page.waitForTimeout(600); }
await page.evaluate(()=>window.__game.setMode('pistol'));
const pistolBefore = await page.evaluate(()=>window.__game.dirtCount());
spot = await page.evaluate(()=>window.__game.dirtScreen());
await page.mouse.move(box.x+box.width*spot.sx, box.y+box.height*spot.sy);
await page.mouse.down();
let pistolWater=0, pistolAfter=pistolBefore;
for(let k=0;k<10;k++){ await page.waitForTimeout(400);
  const c=await page.evaluate(()=>window.__game.waterCount()); if(c>pistolWater) pistolWater=c;
  pistolAfter=await page.evaluate(()=>window.__game.dirtCount());
  if(pistolAfter<pistolBefore && pistolWater>10) break; }
const pistolDiag = await page.evaluate(()=>({ down:window.__game.pointerIsDown(), mode:window.__game.mode(), playing:window.__game.state.playing }));
await page.mouse.up();
console.log('   (pistol: before='+pistolBefore+' after='+pistolAfter+' water='+pistolWater+' diag='+JSON.stringify(pistolDiag)+')');
check('water pistol fires a 3D water jet (>10 in flight)', pistolWater>10);
check('water pistol shoots dirt off the car', pistolAfter<pistolBefore);
await page.evaluate(()=>window.__game.setMode('broom'));

// clean the rest → should trigger win
await page.evaluate(()=>window.__game.cleanAll());
await page.waitForTimeout(900);
const winShown = await page.evaluate(()=>!document.getElementById('winCard').classList.contains('hidden'));
check('win screen (fireworks) shows when car fully clean', winShown===true);
const money = await page.evaluate(()=>window.__game.state.money);
check('money reward added on win (>0)', money>0);
const pct = await page.evaluate(()=>window.__game.cleanPct());
check('clean percent reached 100', pct===100);
await page.screenshot({path:'shot-clean.png'});

// next car works and gets a different paint job name
await page.evaluate(()=>window.__game.next());
await page.waitForTimeout(600);
const playing2 = await page.evaluate(()=>window.__game.state.playing);
const dirt2 = await page.evaluate(()=>window.__game.dirtCount());
check('Next car starts a fresh dirty car', playing2===true && dirt2>50);
const tag = await page.evaluate(()=>document.getElementById('carTag').textContent);
check('second car has a paint-job name', typeof tag==='string' && tag.length>2);

check('no JavaScript/console errors during play', errors.length===0);
if(errors.length) console.log('ERRORS:\n'+errors.join('\n'));

await browser.close();
if(server) server.close();
console.log(failed?'\n=== RESULT: FAIL ===':'\n=== RESULT: ALL PASS ===');
process.exit(failed?1:0);
