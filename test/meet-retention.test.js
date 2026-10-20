import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./meet-hook.test.js", import.meta.url));
const hook = fileURLToPath(new URL("../extension/meet-hook.js", import.meta.url));
for (const stop of ["reset", "expiry", "pagehide", "overflow"]) {
  test("queued raw frame is collectible before stalled conversion settles: " + stop, { timeout: 10000 }, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      const code = (await readFile(${JSON.stringify(helper)}, 'utf8')).split('\\ntest("document-start')[0]
        .replace('new URL("../extension/meet-hook.js", import.meta.url)', ${JSON.stringify(JSON.stringify(hook))});
      const {fixture, packet} = await import('data:text/javascript;base64,' + Buffer.from(code + '\\nexport {fixture,packet};').toString('base64'));
      const cleanup=[]; const f=fixture({after(fn){cleanup.push(fn)}}); f.command('start');
      let release; class Delayed extends Blob { arrayBuffer(){return new Promise(r=>{release=r})} }
      const first=packet(1,'synthetic first'); f.channel.message(new Delayed([first]));
      await new Promise(r=>setImmediate(r)); assert.equal(typeof release,'function');
      let queued=packet(2,'synthetic queued'); const weak=new WeakRef(queued); f.channel.message(queued); queued=null;
      const stop=${JSON.stringify(stop)};
      if(stop==='reset')f.command('reset');
      else if(stop==='expiry')f.expire();
      else if(stop==='pagehide')f.pageEvents.get('pagehide')();
      else f.channel.message(new Uint8Array(262145));
      try {
        let collected=false;
        for(let i=0;i<30;i++) { await new Promise(r=>setImmediate(r)); global.gc(); if(weak.deref()===undefined){collected=true;break;} }
        assert.ok(collected,'not-yet-started payload must be released before first conversion settles');
      } finally { release(first.buffer); await new Promise(r=>setImmediate(r)); for(const fn of cleanup)fn(); }
      console.log('queued payload released');
    `;
    const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 8000, maxBuffer: 12000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /queued payload released/);
  });
}
