// Screenshot helpers for the panel page (an extension page with a DOM): ask the service worker for the meeting tab, shrink it, and tell whether it
// still looks like the previous one. Nothing here is sent anywhere.
const MAX_EDGE = 1280, QUALITY = 0.6, GRID = [32, 18];

// The data URL is decoded by hand: fetching it would be a connect-src violation under the extension pages' CSP (only the bridge is allowed there).
export async function rasterize(dataUrl, { document = globalThis.document, createImageBitmap = globalThis.createImageBitmap, atob = globalThis.atob } = {}) {
  const text = atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), raw = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) raw[i] = text.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([raw], { type: "image/jpeg" }));
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const draw = (width, height) => { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, width, height); return { canvas, context }; };
    const { canvas } = draw(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("encode")), "image/jpeg", QUALITY));
    const { context } = draw(GRID[0], GRID[1]), pixels = context.getImageData(0, 0, GRID[0], GRID[1]).data, signature = new Uint8Array(GRID[0] * GRID[1]);
    for (let i = 0; i < signature.length; i++) signature[i] = Math.round(0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), signature };
  } finally { bitmap.close?.(); }
}

// True when the screen has not meaningfully changed: the signatures differ by no more than `tolerance` on average (0-255) AND no real share of the
// cells changed clearly. The second test matters for a video playing in one part of the screen, which barely moves the average.
export function similar(a, b, tolerance = 4, { cellDelta = 24, cellShare = 0.03 } = {}) {
  if (!a || !b || a.length !== b.length || !a.length) return false;
  let total = 0, changed = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); total += d; if (d > cellDelta) changed++; }
  return total / a.length <= tolerance && changed / a.length < cellShare;
}

// Throws an Error whose `code` is one of a fixed vocabulary (see diagnostics.js), so the panel can say why no picture was taken.
const fail = code => Object.assign(Error(code), { code });
export async function captureScreenshot(tabId, { chrome = globalThis.chrome, rasterize: shrink = rasterize } = {}) {
  let reply;
  try { reply = await chrome.runtime.sendMessage({ type: "live-support-screenshot", tabId }); } catch { throw fail("worker"); }
  if (!reply) throw fail("worker");
  if (!reply.ok) throw fail(["host", "inactive", "rate", "permission"].includes(reply.reason) ? reply.reason : "failed");
  if (typeof reply.dataUrl !== "string" || !reply.dataUrl.startsWith("data:image/jpeg;base64,")) throw fail("format");
  try { return await shrink(reply.dataUrl); } catch { throw fail("decode"); }
}
