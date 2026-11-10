import { app } from 'electron';
import { liinoEngine } from '../electron/audio/liino-engine.ts';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fixture = resolve('../vendor/Liino/testdata/tone-48000-stereo.ogg');
app.whenReady().then(async () => {
  const body = await readFile(fixture);
  const server = createServer((req,res)=>{res.writeHead(200,{'Content-Length':String(body.length),'Content-Type':'application/ogg'});res.end(body);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  const port=(server.address() as any).port;
  liinoEngine.init({baseUrl:`http://127.0.0.1:${port}`,getWin:()=>null,log:(...a)=>console.log('[engine]',...a)});
  liinoEngine.send=()=>{};
  await liinoEngine.call({cmd:'load',url:`http://127.0.0.1:${port}/stream`,paused:false,startAt:0,epoch:9});
  for (let i=0;i<6;i++) {
    await new Promise(r=>setTimeout(r,400));
    const l=await liinoEngine.call({cmd:'level'});
    const s=liinoEngine.st;
    console.log(i,'pos',s.pos.toFixed(2),'level',JSON.stringify((l as any).payload));
  }
  await liinoEngine.shutdown(); server.close(); app.exit(0);
});
