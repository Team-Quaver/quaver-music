import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liinoEngine } from '../electron/audio/liino-engine.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(HERE, '../../vendor/Liino/testdata/tone-48000-stereo.ogg');
const events: any[] = [];

app.whenReady().then(async () => {
  const body = await readFile(fixture);
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
    const start = m ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : body.length - 1;
    if (m) { res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end-start+1), 'Content-Type': 'application/ogg' }); res.end(body.subarray(start,end+1)); return; }
    res.writeHead(200, {'Content-Length': String(body.length), 'Content-Type':'application/ogg'}); res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  liinoEngine.device = 'auto';
  liinoEngine.init({ baseUrl:`http://127.0.0.1:${port}`, getWin:()=>null, log:(...a)=>console.log('[engine]',...a) });
  liinoEngine.send = ev => { events.push(ev); console.log('event', ev); };

  await liinoEngine.call({cmd:'load', url:`http://127.0.0.1:${port}/stream`, paused:false, startAt:0, epoch:9});
  await new Promise(r=>setTimeout(r,500));
  console.log('seek to near end');
  await liinoEngine.call({cmd:'seek', sec:1.5, epoch:9});
  for (let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,200)); const snap=liinoEngine.st; console.log(i, snap); if(snap.idle) break; }
  await liinoEngine.shutdown();
  app.exit(0);
}).catch(e=>{console.error(e); app.exit(2)});
