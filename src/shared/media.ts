import type { MediaKind } from './types';

const EXT_MP4 = /\.mp4(\?|#|$)/i;
const EXT_M3U8 = /\.m3u8(\?|#|$)/i;
const EXT_WEBM = /\.webm(\?|#|$)/i;
const EXT_TS = /\.ts(\?|#|$)/i;

export function detectMediaKind(url: string, mime?: string): MediaKind | null {
  const m = (mime || '').toLowerCase();
  if (m.includes('mpegurl') || m.includes('m3u8') || EXT_M3U8.test(url)) return 'm3u8';
  if (m.includes('mp4') || EXT_MP4.test(url)) return 'mp4';
  if (m.includes('webm') || EXT_WEBM.test(url)) return 'mp4';
  // ignore lone .ts segment sniffing as top-level list items
  if (EXT_TS.test(url) && !EXT_M3U8.test(url)) return null;
  if (m.startsWith('video/')) return 'mp4';
  return null;
}

export function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

export function kindLabel(kind: MediaKind): string {
  if (kind === 'm3u8') return 'M3U8';
  if (kind === 'mp4') return 'MP4';
  return 'VIDEO';
}

export function mediaId(tabId: number, url: string): string {
  return `${tabId}:${url}`;
}

export function guessFilename(title: string, kind: MediaKind, url: string): string {
  const base = (title || 'video')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'video';
  if (kind === 'm3u8') {
    // MVP: concatenated TS often playable; extension chosen on dl page
    return `${base}.ts`;
  }
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(mp4|webm|mov|m4v)(\?|$)/i);
    if (m) return `${base}.${m[1].toLowerCase()}`;
  } catch {
    /* ignore */
  }
  return `${base}.mp4`;
}

/** Popup / badge text: prefer resolution, else kind. */
export function listBadge(item: {
  kind: MediaKind;
  width?: number;
  height?: number;
  label?: string;
}): string {
  if (item.height && item.height > 0) return `${item.height}p`;
  if (item.width && item.width > 0) return `${item.width}w`;
  if (item.label && /p$/i.test(item.label) && item.label !== 'M3U8' && item.label !== 'MP4') {
    return item.label;
  }
  return kindLabel(item.kind);
}

