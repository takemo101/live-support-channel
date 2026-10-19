export const TACTIQ_CONTEXT = "chrome-extension://fggkaccpbmombhnjkjokndojfgagejfb";

// Serialized into Chrome's selected isolated world; keep this function self-contained.
export function readTactiq(meetingId) {
  const host = location.hostname;
  let platform;
  if (host === "meet.google.com") platform = "Google Meet";
  else if (/(^|\.)zoom\.us$/.test(host)) platform = "Zoom";
  else if (["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(host)) platform = "Teams";
  const content = window.tactiq?.content;
  if (!platform || !content?.store?.getState || content.invalidated) return { status: "unavailable" };
  const current = content.store.getState()?.transcriptions?.current;
  if (!current || typeof current !== "object") return { status: "unsupported" };
  if (!meetingId) {
    return {
      status: "ready", platform,
      meetings: Object.entries(current)
        .filter(([, m]) => m?.detectedMeetingStage === "meeting")
        .map(([id, m]) => ({ id, title: String(m.meetingTitle || id).slice(0, 200) })),
    };
  }
  const meeting = current[meetingId];
  if (!meeting || meeting.detectedMeetingStage !== "meeting") return { status: "ended" };
  if (meeting.isPaused !== false) return { status: "paused" };
  if (!Array.isArray(meeting.blocks) || meeting.blocks.length > 4000) return { status: "unsupported" };
  const blocks = [];
  let characters = 0;
  for (const block of meeting.blocks) {
    if (!block || typeof block !== "object"
      || typeof block.messageId !== "string" || !block.messageId.length || block.messageId.length > 512
      || typeof block.transcript !== "string" || block.transcript.length > 32768
      || typeof block.speakerName !== "string" || !block.speakerName.length || block.speakerName.length > 256
      || !Number.isSafeInteger(block.messageVersion) || block.messageVersion < 0
      || !Number.isFinite(block.timestamp) || block.timestamp < 0
      || !Number.isFinite(block.version) || block.version < 0) return { status: "unsupported" };
    characters += block.transcript.length;
    if (characters > 2_000_000) return { status: "unsupported" };
    if (block.isDeleted || ["chat", "screenshot", "page-link"].includes(block.type)) continue;
    const item = {};
    for (const key of ["messageId", "messageVersion", "speakerName", "transcript", "timestamp", "version"]) item[key] = block[key];
    if (typeof block.deviceId === "string" && block.deviceId.length > 0 && block.deviceId.length <= 512) item.deviceId = block.deviceId;
    blocks.push(item);
  }
  return { status: "live", meetingId, platform, blocks };
}
