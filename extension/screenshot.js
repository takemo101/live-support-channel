// Screenshot helpers for the panel page (an extension page with a DOM): ask the service worker for the meeting tab, shrink it, and tell whether it
// still looks like the previous one. Nothing here is sent anywhere.
const MAX_EDGE = 1280, QUALITY = 0.6, GRID = [32, 18];

export async function rasterize(dataUrl, { document = globalThis.document, createImageBitmap = globalThis.createImageBitmap, fetch = globalThis.fetch } = {}) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
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

// True when two signatures differ by no more than `tolerance` on average (0-255): the screen has not meaningfully changed.
export function similar(a, b, tolerance = 4) {
  if (!a || !b || a.length !== b.length || !a.length) return false;
  let total = 0; for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length <= tolerance;
}

export async function captureScreenshot(tabId, { chrome = globalThis.chrome, rasterize: shrink = rasterize } = {}) {
  const reply = await chrome.runtime.sendMessage({ type: "live-support-screenshot", tabId });
  if (!reply?.ok || typeof reply.dataUrl !== "string" || !reply.dataUrl.startsWith("data:image/jpeg;base64,")) return null;
  return shrink(reply.dataUrl);
}
