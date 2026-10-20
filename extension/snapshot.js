// Serialized into the normal page context; invokes only our prepared hook, never a DOM fallback.
export function readCaptions({ action = "discover", meetingId, captureId, previousCaptureId, assistCaptions } = {}) {
  if (action === "reset") {
    const api = window.__liveCaptionsRtc_v1;
    if (api?.version === 1 && typeof api.command === "function") return api.command({ action, captureId });
    return { status: "idle" };
  }
  const host = location.hostname, meet = host === "meet.google.com";
  const teams = ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(host);
  if (location.protocol !== "https:" || (!meet && !teams)) {
    return { status: "unavailable", code: /(^|\.)zoom\.us$/.test(host) ? "PLATFORM_NOT_IMPLEMENTED" : "UNSUPPORTED_HOST" };
  }
  if (meet && !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(location.pathname)) return { status: "ended", code: "NOT_MEETING_PAGE" };
  if (window !== window.top) return { status: "unavailable", code: "UNSUPPORTED_FRAME" };
  // Teams' SPA URL does not identify a call; the capture is bound to the host and to the call's peer connection instead.
  const id = meet ? host + location.pathname.replace(/\/$/, "") : host + "/call";
  if (action !== "discover" && meetingId !== id) return { status: "ended", code: "MEETING_CHANGED" };
  const api = window.__liveCaptionsRtc_v1;
  if (api?.version !== 1 || typeof api.command !== "function") return { status: "unavailable", code: "RTC_HOOK_NOT_READY" };
  return api.command({ action, meetingId: id, captureId, previousCaptureId, assistCaptions });
}
