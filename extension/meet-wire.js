// MAIN/document_start, loaded immediately before meet-hook.js in the same content-script entry.
// Meet's protobuf wire: the tolerant reader (varint, scan, items/walk), the caption decoder for both profiles (decode), the structure-only
// description used to diagnose an unknown frame (shapeOf) and the ACK encoder. Pure functions of bytes: no page, no state.
// The factory is handed over through a one-shot window property that meet-hook.js removes before any page script can run.
(() => {
  const handoff = "__liveCaptionsMeetWire";
  function createWire({ Bytes, Decoder, LIMIT }) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const invalid = () => fail("CAPTION_FORMAT_UNKNOWN");
    function varint(bytes, cursor) {
      let value = 0n;
      for (let i = 0; i < 10; i++) {
        if (cursor.pos >= bytes.length) invalid();
        const b = bytes[cursor.pos++]; if (i === 9 && b > 1) invalid();
        value |= BigInt(b & 127) << BigInt(i * 7);
        if (!(b & 128)) return value;
      }
      invalid();
    }
    // Decoding follows protobuf semantics (unknown fields skipped, a repeated field keeps its last value, zero-valued fields are absent on the wire),
    // like the app's own decoder. A frame that is not a usable caption is dropped and counted, never fatal.
    function scan(bytes) {
      const out = new Map(), cursor = { pos: 0 };
      while (cursor.pos < bytes.length) {
        const tag = varint(bytes, cursor), field = Number(tag >> 3n), wire = Number(tag & 7n);
        if (!field) invalid();
        let value;
        if (wire === 0) value = varint(bytes, cursor);
        else if (wire === 1 || wire === 2 || wire === 5) {
          let length = wire === 1 ? 8 : 4;
          if (wire === 2) { const n = varint(bytes, cursor); if (n > BigInt(LIMIT)) invalid(); length = Number(n); }
          if (cursor.pos + length > bytes.length) invalid();
          value = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length;
        } else invalid();
        out.set(field, { wire, value });
      }
      return out;
    }
    const part = (map, field, wire) => { const item = map.get(field); return item && item.wire === wire ? item.value : null; };
    function text(bytes, max) {
      const value = new Decoder("utf-8").decode(bytes);
      if (value.length > max) fail("CAPTION_LIMIT"); return value;
    }
    // Returns a packet, null for a control frame, or the reason ("frame", "utterance", "device", "id") why the frame is not a usable caption.
    function decode(bytes, label) {
      let id, revision, device, body;
      try {
        const outer = scan(bytes);
        if (label === "captions") {
          if (part(outer, 2, 2)?.length) return null;
          const message = part(outer, 1, 2); if (!message) return "utterance";
          const fields = scan(message);
          device = part(fields, 1, 2); id = part(fields, 2, 0); revision = part(fields, 3, 0) ?? 0n; body = part(fields, 6, 2);
        } else {
          const message = part(outer, 1, 2); if (!message) return "utterance";
          // The real wire (seen on Meet, structure only) nests the utterance one level deeper: {1: {1: id, 2: version, 3: caption}, 6: {...}}. The app's own
          // decoder reads a field by number whatever its wire type, so it flattens that nesting by accident; we open it explicitly (at most twice).
          let fields = scan(message);
          for (let depth = 0; depth < 2 && !part(fields, 3, 2); depth++) { const wrapped = part(fields, 1, 2); if (!wrapped) break; fields = scan(wrapped); }
          const caption = part(fields, 3, 2); if (!caption) return "utterance";
          id = part(fields, 1, 0); revision = part(fields, 2, 0) ?? 0n;
          const inner = scan(caption); device = part(inner, 6, 2); body = part(inner, 3, 2);
        }
      } catch { return "frame"; }
      if (id === null || id < 1n || id > 0x7fffffffffffffffn || revision > BigInt(Number.MAX_SAFE_INTEGER)) return "id";
      if (!device || device.length > 2048) return "device";
      const deviceId = text(device, 512);
      if (!deviceId || /\p{Cc}/u.test(deviceId)) return "device";
      return { id, revision: Number(revision), device: deviceId, text: body === null ? null : text(body, 32768) };
    }
    function integer(value) {
      const out = []; do { const b = Number(value & 127n); value >>= 7n; out.push(b | (value ? 128 : 0)); } while (value);
      return out;
    }
    function ack(id, revision) {
      const ref = [8, ...integer(id), 16, ...integer(BigInt(revision)), 24, 1];
      const body = [10, ref.length, ...ref]; return Bytes.from([10, body.length, ...body]);
    }
    function items(bytes) {
      const out = []; const cursor = { pos: 0 };
      while (cursor.pos < bytes.length) {
        const tag = varint(bytes, cursor), field = Number(tag >> 3n), wire = Number(tag & 7n);
        if (!field) invalid();
        if (wire === 0) { varint(bytes, cursor); continue; }
        let length;
        if (wire === 2) { const n = varint(bytes, cursor); if (n > BigInt(LIMIT)) invalid(); length = Number(n); }
        else if (wire === 1) length = 8; else if (wire === 5) length = 4; else invalid();
        if (cursor.pos + length > bytes.length) invalid();
        if (wire === 2) out.push({ field, value: bytes.subarray(cursor.pos, cursor.pos + length) });
        cursor.pos += length;
      }
      return out;
    }
    // Follows a path of length-delimited field numbers; a repeated field fans out.
    function walk(bytes, path) {
      let layer = [bytes];
      for (const field of path) { const next = []; for (const part of layer) for (const item of items(part)) if (item.field === field) next.push(item.value); layer = next.slice(0, 256); }
      return layer;
    }
    // Structure only (field numbers and wire types, never values): lets a mismatch with the real wire be diagnosed without any caption text.
    // A length-delimited field is opened only if it holds a control byte, which plain text never does.
    function shapeOf(bytes, depth = 5) {
      const parts = [], cursor = { pos: 0 };
      try {
        while (cursor.pos < bytes.length && parts.length < 12) {
          const tag = varint(bytes, cursor), field = Number(tag >> 3n), wire = Number(tag & 7n);
          if (!field || field > 1000) { parts.push("!"); break; }
          if (wire === 0) { varint(bytes, cursor); parts.push(field + ":0"); }
          else if (wire === 1 || wire === 5) { cursor.pos += wire === 1 ? 8 : 4; if (cursor.pos > bytes.length) { parts.push("!"); break; } parts.push(field + ":" + wire); }
          else if (wire === 2) {
            const length = Number(varint(bytes, cursor)); if (cursor.pos + length > bytes.length) { parts.push("!"); break; }
            const inner = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length;
            const nested = depth > 1 && length > 1 && inner.some(b => b < 0x20) ? shapeOf(inner, depth - 1) : "";
            parts.push(field + ":2" + (nested && !nested.includes("!") ? "(" + nested + ")" : ""));
          } else { parts.push("!"); break; }
        }
      } catch { parts.push("!"); }
      return parts.join(",");
    }
    return { varint, scan, part, text, decode, integer, ack, items, walk, shapeOf };
  }
  Object.defineProperty(window, handoff, { value: createWire, configurable: true, writable: false });
})();
