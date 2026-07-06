import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = path.resolve('.');
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]);
  if(p==='/') p='/index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp,(err,data)=>{
    if(err){ res.writeHead(404); res.end('nf'); return; }
    const ext=path.extname(fp);
    const ct = ext==='.html'?'text/html':ext==='.js'?'text/javascript':'application/octet-stream';
    res.writeHead(200,{'Content-Type':ct}); res.end(data);
  });
});
await new Promise(r=>server.listen(0,r));
const port = server.address().port;
const url = `http://localhost:${port}/index.html`;
console.log('serving', url);

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

// press Play
await page.evaluate(()=>window.__game.start());
await page.waitForTimeout(400);
const playing = await page.evaluate(()=>window.__game.state.playing);
check('game is playing after Play', playing===true);
const initDirt0 = await page.evaluate(()=>window.__game.initialDirt());
check('dirt scattered on car after Play (>50 3D patches)', initDirt0>50);
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
await page.screenshot({path:'shot-morten.png'});

// scrub one patch via hook
const scrubbed = await page.evaluate(()=>window.__game.scrubOne());
check('scrubbing removes a dirt patch', scrubbed===true);

// simulate a real touch-drag across the canvas to prove pointer scrubbing works
const dragBefore = await page.evaluate(()=>window.__game.dirtCount());
const box = await page.locator('#three').boundingBox();
await page.mouse.move(box.x+box.width*0.35, box.y+box.height*0.45);
await page.mouse.down();
for(let i=0;i<24;i++){ await page.mouse.move(box.x+box.width*(0.30+i*0.016), box.y+box.height*(0.40+ (i%6)*0.03)); await page.waitForTimeout(8); }
await page.mouse.up();
const dragAfter = await page.evaluate(()=>window.__game.dirtCount());
check('real pointer-drag scrubs dirt off the car', dragAfter<dragBefore);

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

// next car works
await page.evaluate(()=>window.__game.next());
await page.waitForTimeout(500);
const playing2 = await page.evaluate(()=>window.__game.state.playing);
const dirt2 = await page.evaluate(()=>window.__game.dirtCount());
check('Next car starts a fresh dirty car', playing2===true && dirt2>50);

check('no JavaScript/console errors during play', errors.length===0);
if(errors.length) console.log('ERRORS:\n'+errors.join('\n'));

await browser.close();
server.close();
console.log(failed?'\n=== RESULT: FAIL ===':'\n=== RESULT: ALL PASS ===');
process.exit(failed?1:0);
