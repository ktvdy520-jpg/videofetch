import muxjs from 'mux.js';

type MuxSegmentEvent = {
  initSegment?: Uint8Array | ArrayBuffer;
  data: Uint8Array | ArrayBuffer;
  type?: string;
};

function toU8(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Remux MPEG-TS segments → fragmented MP4 via mux.js (browser-local, no ffmpeg).
 * Pushing per-segment matches how HLS players feed the transmuxer.
 */
export function transmuxTsSegmentsToMp4(tsSegments: Uint8Array[]): Uint8Array {
  if (tsSegments.length === 0) {
    throw new Error('没有可转换的 TS 分片');
  }

  const Transmuxer = (
    muxjs as unknown as { mp4: { Transmuxer: new (opts?: object) => {
      on: (ev: string, cb: (data: MuxSegmentEvent) => void) => void;
      push: (data: ArrayBuffer) => void;
      flush: () => void;
      dispose?: () => void;
    } } }
  ).mp4.Transmuxer;

  const transmuxer = new Transmuxer({ keepOriginalTimestamps: true });
  const out: Uint8Array[] = [];
  let initAdded = false;

  transmuxer.on('data', (segment) => {
    if (segment.initSegment && !initAdded) {
      out.push(toU8(segment.initSegment));
      initAdded = true;
    }
    if (segment.data && (segment.data as ArrayBuffer).byteLength !== undefined) {
      const u8 = toU8(segment.data);
      if (u8.byteLength > 0) out.push(u8);
    }
  });

  for (const seg of tsSegments) {
    if (!seg.byteLength) continue;
    transmuxer.push(asArrayBuffer(seg));
    transmuxer.flush();
  }

  transmuxer.dispose?.();

  if (!initAdded || out.length === 0) {
    throw new Error('mux.js 未能生成 MP4（可能不是标准 MPEG-TS）');
  }
  return concat(out);
}
