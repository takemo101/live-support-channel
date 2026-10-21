// Service worker. It exists for one thing: taking a screenshot of the meeting tab for the panel, because only an extension's own worker can call
// chrome.tabs.captureVisibleTab. It never reads page content, keeps nothing, and only answers the extension's own panel page.
const HOSTS = new Set(["meet.google.com", "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "app.zoom.us"]);
let last = 0;

async function capture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let url; try { url = new URL(tab.url ?? ""); } catch { return { ok: false, reason: "url" }; }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return { ok: false, reason: "host" };
  // captureVisibleTab shows whatever tab is in front of its window: never take a picture of some other tab.
  if (!tab.active) return { ok: false, reason: "inactive" };
  const now = Date.now();
  if (now - last < 1000) return { ok: false, reason: "rate" };
  last = now;
  return { ok: true, dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }) };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("panel.html"))) return false;
  if (message?.type !== "live-support-screenshot" || !Number.isSafeInteger(message.tabId)) return false;
  capture(message.tabId).then(respond, () => respond({ ok: false, reason: "failed" }));
  return true;
});
