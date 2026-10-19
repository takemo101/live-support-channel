const keyOf = block => JSON.stringify([block.messageId, block.deviceId ?? ""]);
const hashes = snapshot => new Map(snapshot.blocks.map(block => [keyOf(block), JSON.stringify(block)]));

export class CaptionStream {
  constructor(send) { this.send = send; }
  start(snapshot) {
    if (snapshot.status !== "live") throw new Error("Tactiq is not actively transcribing");
    const baseline = hashes(snapshot);
    this.run = { sessionId: crypto.randomUUID(), meetingId: snapshot.meetingId, platform: snapshot.platform, sequence: 0, baseline, excluded: new Set(baseline.keys()) };
  }
  stop() { this.run = null; }
  async update(snapshot) {
    let run = this.run;
    if (!run) return;
    if (snapshot.status === "paused") {
      // Never replay a queued pre-pause batch or text accumulated while paused.
      this.run = { ...run, sessionId: crypto.randomUUID(), sequence: 0, baseline: null, pending: null };
      return;
    }
    if (snapshot.status !== "live" || snapshot.meetingId !== run.meetingId) { this.stop(); return; }
    if (this.busy) return;
    if (!run.baseline) {
      run.baseline = hashes(snapshot);
      run.excluded = new Set(run.baseline.keys());
      return;
    }
    if (!run.pending) {
      const updates = [];
      let bytes = 0;
      for (const block of snapshot.blocks) {
        const json = JSON.stringify(block);
        // A later revision may repeat a private prefix from before start/resume.
        if (run.excluded.has(keyOf(block)) || run.baseline.get(keyOf(block)) === json) continue;
        const size = new TextEncoder().encode(json).length;
        if (size > 240000) throw Object.assign(new Error("Caption update exceeds the transport limit"), { fatal: true });
        if (updates.length >= 64 || bytes + size > 240000) break;
        updates.push(block);
        bytes += size;
      }
      if (!updates.length) return;
      run.pending = { sessionId: run.sessionId, sequence: run.sequence + 1, meetingId: run.meetingId, platform: run.platform, updates };
    }
    this.busy = true;
    try {
      await this.send(run.pending);
      if (this.run !== run) return;
      for (const block of run.pending.updates) run.baseline.set(keyOf(block), JSON.stringify(block));
      run.sequence = run.pending.sequence;
      run.pending = null;
    } finally { this.busy = false; }
  }
}
