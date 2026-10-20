// Runs `suite(window, capture, ServerPeer)` in an isolated headless Chrome page that loads one hook under a faked https location.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptions } from "../extension/snapshot.js";

export const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => p && existsSync(p));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runInChrome(t, { hook, hostname, pathname, body = "", suite }) {
  const temp = await mkdtemp(join(tmpdir(), "hook-chrome-"));
  let browser, socket;
  t.after(async () => {
    socket?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, "exit"); browser.kill("SIGTERM");
      await Promise.race([exited, delay(1000)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
    }
    await rm(temp, { recursive: true, force: true });
  });
  const source = await readFile(new URL("../extension/" + hook, import.meta.url), "utf8");
  const html = "<!doctype html><html><body>" + body + "<script>"
    + 'const ServerPeer=window.RTCPeerConnection;const values={location:{protocol:"https:",hostname:' + JSON.stringify(hostname) + ',pathname:' + JSON.stringify(pathname) + '},RTCPeerConnection:ServerPeer};let scope;scope=new Proxy(window,{get(target,key){if(key==="top")return scope;if(Object.hasOwn(values,key))return values[key];const v=target[key];return ["setTimeout","clearTimeout","addEventListener"].includes(key)?v.bind(target):v;},set(target,key,value){values[key]=value;return true;}});'
    + "(function(window){" + source + "})(scope);"
    + "window.__testPromise=(async function(window,location){const capture=" + readCaptions.toString() + ";"
    + "try{return await (" + suite.toString() + ")(window,capture,ServerPeer);}catch(e){return {ok:false,error:String(e),stack:e.stack};}})(scope,values.location);</script></body></html>";
  const file = join(temp, "fixture.html"), profile = join(temp, "profile"); await writeFile(file, html);
  browser = spawn(chrome, ["--headless=new", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile, "file://" + file], { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.resume();
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch {}
    if (!port) { if (browser.exitCode !== null) throw Error("isolated Chrome exited"); await delay(20); }
  }
  assert.ok(port, "isolated Chrome did not expose its local test CDP endpoint");
  let target;
  for (let i = 0; i < 250 && !target; i++) {
    try { target = (await (await fetch("http://127.0.0.1:" + port + "/json/list")).json()).find(p => p.type === "page" && p.url.startsWith("file://")); } catch {}
    if (!target) await delay(20);
  }
  assert.ok(target, "isolated Chrome did not list its test page");
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  let next = 0; const pending = new Map();
  socket.addEventListener("message", event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result); } });
  const evaluate = expression => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Error("Chrome test evaluation timeout")); }, 18000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
  let evaluated;
  for (let attempt = 0; attempt < 10 && !evaluated; attempt++) {
    // The page may still be committing its navigation: a destroyed context is retried, anything else is a real failure.
    try { evaluated = await evaluate("(async () => { for (let i = 0; i < 500 && !window.__testPromise; i++) await new Promise(r => setTimeout(r, 20)); return window.__testPromise; })()"); }
    catch (error) { if (!/context was destroyed|Cannot find context/i.test(error.message) || attempt === 9) throw error; await delay(50); }
  }
  assert.equal(evaluated.exceptionDetails, undefined, evaluated.exceptionDetails?.text);
  const result = evaluated.result.value; assert.ok(result); assert.equal(result.ok, true, result.error + "\n" + result.stack);
  return result;
}
