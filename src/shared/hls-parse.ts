/** Lightweight HLS playlist helpers for sniff enrichment (no download). */

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  width?: number;
  height?: number;
}

export interface HlsParseResult {
  isMaster: boolean;
  variants: HlsVariant[];
  hasSegments: boolean;
}

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

export function parseHlsPlaylist(text: string, playlistUrl: string): HlsParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const variants: HlsVariant[] = [];
  let isMaster = false;
  let hasSegments = false;
  let pendingBw = 0;
  let pendingW: number | undefined;
  let pendingH: number | undefined;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      pendingBw = bw ? Number(bw[1]) : 0;
      pendingW = res ? Number(res[1]) : undefined;
      pendingH = res ? Number(res[2]) : undefined;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      hasSegments = true;
      continue;
    }
    if (line.startsWith('#')) continue;

    const uri = resolveUrl(playlistUrl, line);
    if (isMaster || /\.m3u8(\?|$)/i.test(line)) {
      isMaster = true;
      variants.push({
        uri,
        bandwidth: pendingBw,
        width: pendingW,
        height: pendingH,
      });
      pendingBw = 0;
      pendingW = undefined;
      pendingH = undefined;
    } else {
      hasSegments = true;
    }
  }

  if (variants.length > 0) {
    return { isMaster: true, variants, hasSegments: false };
  }
  return { isMaster: false, variants: [], hasSegments };
}

/** Prefer height as "1080p"; fall back to width. */
export function formatResolutionLabel(width?: number, height?: number): string {
  if (height != null && height > 0) return `${height}p`;
  if (width != null && width > 0) return `${width}w`;
  return 'n/a';
}

export function guessResolutionFromUrl(url: string): { width?: number; height?: number } {
  try {
    const s = decodeURIComponent(url);
    const wh = /(\d{2,4})x(\d{2,4})/i.exec(s);
    if (wh) {
      const w = Number(wh[1]);
      const h = Number(wh[2]);
      if (w >= 160 && h >= 120) return { width: w, height: h };
    }
    const p = /(?:^|[^\d])(2160|1440|1080|720|540|480|360|240)p(?:[^\d]|$)/i.exec(s);
    if (p) {
      const h = Number(p[1]);
      return { height: h };
    }
    // path segments like /1080/ or _1080_
    const lone = /(?:^|[/_-])(2160|1440|1080|720|540|480|360|240)(?:[/_-]|$)/.exec(s);
    if (lone) return { height: Number(lone[1]) };
  } catch {
    /* ignore */
  }
  return {};
}
