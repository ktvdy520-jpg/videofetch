import type { CapturedMedia, DlQuery, MediaKind } from './types';

/** Default official site (GitHub Pages). */
export const DEFAULT_WEB_DL_URL =
  'https://ktvdy520-jpg.github.io/videofetch/dl.html';

export function buildDlPageUrl(media: CapturedMedia, extensionOrigin: string): string {
  const q = buildQuery(media);
  const base = extensionOrigin.replace(/\/$/, '');
  return `${base}/src/dl/index.html?${q.toString()}`;
}

export function buildWebDlPageUrl(
  media: CapturedMedia,
  pageUrl: string = DEFAULT_WEB_DL_URL,
): string {
  const u = new URL(pageUrl);
  const q = buildQuery(media);
  q.forEach((v, k) => u.searchParams.set(k, v));
  return u.toString();
}

function buildQuery(media: CapturedMedia): URLSearchParams {
  const q = new URLSearchParams();
  q.set('url', media.url);
  q.set('query', media.url); // Qooly-compatible alias
  q.set('title', media.title || 'video');
  q.set('type', media.kind === 'm3u8' ? 'm3u8' : 'mp4');
  q.set('source', media.pageUrl || '');
  if (media.sizeBytes != null) q.set('size', String(media.sizeBytes));
  if (media.width != null) q.set('width', String(media.width));
  if (media.height != null) q.set('height', String(media.height));
  return q;
}

export function parseDlQuery(search: string): DlQuery | null {
  const q = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const url = q.get('url') || q.get('query');
  if (!url) return null;
  const type = (q.get('type') || '') as MediaKind;
  const inferred: MediaKind = /\.m3u8(\?|$)/i.test(url)
    ? 'm3u8'
    : type === 'm3u8'
      ? 'm3u8'
      : type === 'other'
        ? 'other'
        : 'mp4';
  return {
    url,
    title: q.get('title') || 'video',
    type: inferred,
    source: q.get('source') || '',
    size: q.get('size') ? Number(q.get('size')) : undefined,
    width: q.get('width') ? Number(q.get('width')) : undefined,
    height: q.get('height') ? Number(q.get('height')) : undefined,
  };
}
