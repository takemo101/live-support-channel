// MAIN/document_start on Teams. Intercepts the caption results Teams' own calling code receives; reads nothing from the page DOM and never starts captions or mutates the page.
// Only after an explicit start: the call's remote-event handler is wrapped (the original is always called, and restored at the end).
// No transcript processing and no patching while idle; never sends, or touches tokens, HTTP or sockets.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore;
  try { delete page.__liveCaptionsHookCore; } catch {}
  const hosts = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);
  if (typeof core !== "function" || page !== page.top || page.location.protocol !== "https:" || !hosts.has(page.location.hostname) || page[key]) return;
  const currentMeeting = () => page.location.protocol === "https:" && hosts.has(page.location.hostname) ? `${page.location.hostname}/call` : null;
  // The app publishes its calling context as a WeakRef; the active call carries the data-channel subscriptions and the participant list.
  const activeCall = () => { try { return page.msteamscalling?.deref?.()?.callingService?.getActiveCall?.() ?? null; } catch { return null; } };
  const handlerOf = call => {
    try { return call?.dataChannel?.subscriptions?.find(entry => entry?.eventHandler?.on?.name === "remoteUserEventsReceived")?.eventHandler?.on ?? null; } catch { return null; }
  };
  const life = core(page, { meeting: currentMeeting, check: s => activeCall() === null ? "TEAMS_CALL_ENDED" : null,
    cleanup(s) { s.records.clear(); s.speakers.clear(); s.bounds.clear(); s.call = null; } });
  const { finish } = life;
  // Teams' own text can carry NULs and replacement characters.
  const sanitize = text => {
    if (typeof text !== "string" || text.length > 32768) return null;
    const value = text.replace(/\0/g, "").replace(/\ufffd/g, "");
    return value.trim() ? value : "";
  };
  function stampOf(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value));
    if (typeof value === "string" && /^\d{1,20}$/.test(value)) return BigInt(value);
    return null;
  }
  function ingest(s, item) {
    if (!item || typeof item !== "object" || !("timestampAudioSent" in item)) return;
    const stamp = stampOf(item.timestampAudioSent), user = item.userId, text = sanitize(item.text);
    if (stamp === null || typeof user !== "string" || !user || user.length > 512 || text === null) { life.drop(s); return; }
    // No verified clock: each speaker's first utterance and anything older is excluded as history (and its later revisions with it).
    let bound = s.bounds.get(user);
    if (bound === undefined) { if (s.bounds.size >= 256) throw life.invalid(); bound = stamp; s.bounds.set(user, bound); }
    if (!text) return;
    life.offer(s, { key: `${stamp}/${user}`, speaker: user, text, excluded: stamp <= bound });
  }
  function receive(s, type, payload) {
    if (String(type) !== "3") return;
    let body = payload;
    if (typeof payload === "string") { if (payload.length > 262144) return; try { body = JSON.parse(payload); } catch { return; } }
    const results = body && typeof body === "object" && Array.isArray(body.recognitionResults) ? body.recognitionResults.slice(0, 65) : null;
    if (results) for (const item of results) ingest(s, item);
  }
  function attach(s) {
    const call = activeCall(); if (!call) throw life.invalid();
    s.call = call;
    let target = null, original = null;
    // Never throws into Teams and always hands the call on to the original handler.
    const wrapper = function (type, payload) {
      life.guard(s, () => receive(s, type, payload));
      return original.apply(this, arguments);
    };
    const found = handlerOf(call); if (!found || typeof found.handler !== "function") throw life.invalid();
    original = found.handler; target = found; found.handler = wrapper;
    return () => { if (target.handler === wrapper) target.handler = original; };
  }
  const nameOf = (record, s) => {
    try {
      const call = s.call;
      const person = call?.participants?.find?.(p => p?.mri === record.speaker);
      if (person?.displayName) return life.displayName(person.displayName);
      const self = call?.currentUserSkypeIdentity;
      return self && self.mri === record.speaker ? life.displayName(self.displayName) : "";
    } catch { return ""; }
  };
  function metadata() {
    const id = currentMeeting(), target = handlerOf(activeCall());
    const code = !id ? "NOT_MEETING_PAGE" : target && typeof target.handler === "function" ? "READY" : "TEAMS_CALL_NOT_FOUND";
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, dropped: 0, queued: 0 };
    return { status: "ready", source: "teams-call-experimental", platform: "Teams",
      meetings: id ? [{ id, title: "Microsoft Teams（通話の字幕イベント・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: 0, captionChannels: 0, ...stats } };
  }
  const command = params => life.messageCommand(params ?? {}, { metadata, platform: "Teams", attach, nameOf, extra: { bounds: new Map(), call: null } });
  Object.defineProperty(page, key, { value: Object.freeze({ version: 1, command }), configurable: false, writable: false });
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
