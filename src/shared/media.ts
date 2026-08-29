import type { MediaKind } from './types';

const EXT_MP4 = /\.mp4(\?|#|$)/i;
const EXT_M3U8 = /\.m3u8(\?|#|$)/i;
const EXT_WEBM = /\.webm(\?|#|$)/i;
const EXT_TS = /\.ts(\?|#|$)/i;
const EXT_M4S = /\.m4s(\?|#|$)/i;
const EXT_SUB = /\.(vtt|srt)(\?|#|$)/i;

/** Align with Qooly: skip tiny responses when Content-Length is known. */
export const MIN_MEDIA_BYTES = 1024;

/**
 * Normalize media URLs before dedupe / list id.
 * Instagram CDN often splits one MP4 into many range requests via bytestart/byteend.
 */
export function normalizeMediaUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    u.searchParams.delete('bytestart');
    u.searchParams.delete('byteend');
    u.searchParams.delete('range');
    u.searchParams.delete('bytes');
    u.hash = '';
    return u.toString();
  } catch {
    return trimmed
      .replace(/&bytestart=\d*/gi, '')
      .replace(/&byteend=\d*/gi, '')
      .replace(/\?bytestart=\d*&?/gi, '?')
      .replace(/\?byteend=\d*&?/gi, '?')
      .replace(/\?&/, '?')
      .replace(/\?$/, '');
  }
}

export function detectMediaKind(url: string, mime?: string): MediaKind | null {
  const m = (mime || '').toLowerCase();
  if (EXT_SUB.test(url) || url.includes('/subtitle/')) return null;
  // HLS media segments — keep playlists only (Qooly ignores most .m4s).
  if (EXT_M4S.test(url)) return null;
  if (EXT_TS.test(url) && !EXT_M3U8.test(url)) return null;

  if (
    m.includes('mpegurl') ||
    m.includes('m3u8') ||
    m === 'application/vnd.apple.mpegurl' ||
    EXT_M3U8.test(url)
  ) {
    return 'm3u8';
  }
  if (m.includes('mp4') || EXT_MP4.test(url)) return 'mp4';
  if (m.includes('webm') || EXT_WEBM.test(url)) return 'mp4';
  if (m.startsWith('video/')) return 'mp4';
  return null;
}

/** True when Content-Length is present and too small to list. */
export function isTooSmallMedia(sizeBytes?: number): boolean {
  return (
    sizeBytes != null &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= MIN_MEDIA_BYTES
  );
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
  return `${tabId}:${normalizeMediaUrl(url)}`;
}

export function guessFilename(title: string, kind: MediaKind, url: string): string {
  const base =
    (title || 'video')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'video';
  if (kind === 'm3u8') {
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
