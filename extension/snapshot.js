// Serialized into the normal page context; invokes only our prepared hook, never a DOM fallback.
export function readCaptions({ action = "discover", meetingId, captureId, previousCaptureId } = {}) {
  if (action === "reset") {
    const api = window.__liveCaptionsRtc_v1;
    if (api?.version === 1 && typeof api.command === "function") return api.command({ action, captureId });
    return { status: "idle" };
  }
  const host = location.hostname;
  if (host !== "meet.google.com" || location.protocol !== "https:") {
    const pending = /(^|\.)zoom\.us$/.test(host) || ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(host);
    return { status: "unavailable", code: pending ? "PLATFORM_NOT_IMPLEMENTED" : "UNSUPPORTED_HOST" };
  }
  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(location.pathname)) return { status: "ended", code: "NOT_MEETING_PAGE" };
  if (window !== window.top) return { status: "unavailable", code: "UNSUPPORTED_FRAME" };
  const id = host + location.pathname.replace(/\/$/, "");
  if (action !== "discover" && meetingId !== id) return { status: "ended", code: "MEETING_CHANGED" };
  const api = window.__liveCaptionsRtc_v1;
  if (api?.version !== 1 || typeof api.command !== "function") return { status: "unavailable", code: "RTC_HOOK_NOT_READY" };
  return api.command({ action, meetingId: id, captureId, previousCaptureId });
}
