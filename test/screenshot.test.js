import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { captureScreenshot, similar } from "../extension/screenshot.js";
import { chrome as chromeBinary, runInChrome } from "../test-support/chrome.js";

test("similar tells an unchanged screen from a changed one and refuses to compare unlike signatures", () => {
  const a = new Uint8Array(576).fill(100), near = a.map(v => v + 3), far = a.map((v, i) => i < 288 ? v : v + 80);
  assert.equal(similar(a, a), true); assert.equal(similar(a, near), true); assert.equal(similar(a, far), false);
  assert.equal(similar(null, a), false); assert.equal(similar(a, new Uint8Array(10)), false); assert.equal(similar(new Uint8Array(0), new Uint8Array(0)), false);
});
test("captureScreenshot only accepts a JPEG data URL from the worker and hands it on to be shrunk", async () => {
  const asked = [], shrink = async url => ({ bytes: Uint8Array.of(1), signature: new Uint8Array(1), url });
  const chrome = reply => ({ runtime: { sendMessage: async message => { asked.push(message); return reply; } } });
  assert.deepEqual(plain(await captureScreenshot(7, { chrome: chrome({ ok: true, dataUrl: "data:image/jpeg;base64,AAAA" }), rasterize: shrink })).url, "data:image/jpeg;base64,AAAA");
  assert.deepEqual(asked, [{ type: "live-support-screenshot", tabId: 7 }]);
  const why = async (reply, options = {}) => captureScreenshot(7, { chrome: options.chrome ?? chrome(reply), rasterize: options.rasterize ?? shrink }).then(() => "none", error => error.code);
  assert.equal(await why(undefined), "worker"); assert.equal(await why({ ok: false, reason: "inactive" }), "inactive"); assert.equal(await why({ ok: false, reason: "permission" }), "permission");
  assert.equal(await why({ ok: false, reason: "<script>" }), "failed"); assert.equal(await why({ ok: true }), "format");
  assert.equal(await why({ ok: true, dataUrl: "data:text/html;base64,AAAA" }), "format"); assert.equal(await why({ ok: true, dataUrl: "https://evil.example/x.jpg" }), "format");
  assert.equal(await why(null, { chrome: { runtime: { sendMessage: async () => { throw Error("Could not establish connection"); } } } }), "worker");
  assert.equal(await why({ ok: true, dataUrl: "data:image/jpeg;base64,AAAA" }, { rasterize: async () => { throw Error("bad image"); } }), "decode");
});
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test("real Chrome: rasterize shrinks to 1280px, encodes a JPEG and produces a stable signature", { skip: !chromeBinary, timeout: 40000 }, async t => {
  const source = (await readFile(new URL("../extension/screenshot.js", import.meta.url), "utf8")).replace(/^export /gm, "");
  const suite = async function () {
    let checks = 0;
    const eq = (a, b, name) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(name + ": " + JSON.stringify(a)); checks++; };
    const paint = (width, height, colors) => { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const c = canvas.getContext("2d");
      colors.forEach((color, i) => { c.fillStyle = color; c.fillRect(i * width / colors.length, 0, width / colors.length, height); }); return canvas.toDataURL("image/jpeg", 0.9); };
    const big = await rasterize(paint(2000, 1000, ["#c00", "#0c0", "#00c"]));
    eq([big.bytes[0], big.bytes[1], big.bytes[2]], [0xff, 0xd8, 0xff], "a JPEG");
    const decoded = await createImageBitmap(new Blob([big.bytes], { type: "image/jpeg" })); eq([decoded.width, decoded.height], [1280, 640], "long edge is 1280, aspect kept");
    const small = await rasterize(paint(320, 180, ["#c00", "#0c0", "#00c"])); const smallImage = await createImageBitmap(new Blob([small.bytes])); eq([smallImage.width, smallImage.height], [320, 180], "never upscaled");
    eq(big.signature.length, 32 * 18, "signature grid");
    const again = await rasterize(paint(2000, 1000, ["#c00", "#0c0", "#00c"])); eq(similar(big.signature, again.signature), true, "the same screen is similar");
    const other = await rasterize(paint(2000, 1000, ["#00c", "#fff", "#000"])); eq(similar(big.signature, other.signature), false, "a different screen is not");
    eq(big.bytes.length < 200000, true, "small enough to upload");
    return { ok: true, checks };
  };
  const result = await runInChrome(t, { hook: "zoom-hook.js", hostname: "app.zoom.us", pathname: "/wc/12345678/join", body: "<script>" + source + "</script>", suite });
  assert.ok(result.checks >= 7);
});

test("real Chrome: rasterize works under the extension pages' CSP (connect-src allows only the bridge, so a data: URL must not be fetched)", { skip: !chromeBinary, timeout: 40000 }, async t => {
  const source = (await readFile(new URL("../extension/screenshot.js", import.meta.url), "utf8")).replace(/^export /gm, "");
  const suite = async function () {
    const meta = document.createElement("meta"); meta.httpEquiv = "Content-Security-Policy"; meta.content = "connect-src http://127.0.0.1:43821"; document.head.append(meta);
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360; const c = canvas.getContext("2d"); c.fillStyle = "#336"; c.fillRect(0, 0, 640, 360);
    const url = canvas.toDataURL("image/jpeg", 0.8);
    let controlBlocked = false; try { await fetch(url); } catch { controlBlocked = true; }
    const shot = await rasterize(url);
    return { ok: true, checks: 1, controlBlocked, jpeg: [shot.bytes[0], shot.bytes[1]], signature: shot.signature.length };
  };
  const result = await runInChrome(t, { hook: "zoom-hook.js", hostname: "app.zoom.us", pathname: "/wc/12345678/join", body: "<script>" + source + "</script>", suite });
  assert.equal(result.controlBlocked, true, "the CSP in this page really blocks fetching a data: URL");
  assert.deepEqual([result.jpeg, result.signature], [[0xff, 0xd8], 576]);
});
