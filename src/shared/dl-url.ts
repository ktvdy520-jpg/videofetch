import type { CapturedMedia, DlQuery, MediaKind } from './types';

export function buildDlPageUrl(media: CapturedMedia, extensionOrigin: string): string {
  const q = new URLSearchParams();
  q.set('url', media.url);
  q.set('title', media.title || 'video');
  q.set('type', media.kind);
  q.set('source', media.pageUrl || '');
  if (media.sizeBytes != null) q.set('size', String(media.sizeBytes));
  if (media.width != null) q.set('width', String(media.width));
  if (media.height != null) q.set('height', String(media.height));
  const base = extensionOrigin.replace(/\/$/, '');
  return `${base}/src/dl/index.html?${q.toString()}`;
}

export function parseDlQuery(search: string): DlQuery | null {
  const q = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const url = q.get('url');
  if (!url) return null;
  const type = (q.get('type') || 'mp4') as MediaKind;
  return {
    url,
    title: q.get('title') || 'video',
    type: type === 'm3u8' ? 'm3u8' : type === 'other' ? 'other' : 'mp4',
    source: q.get('source') || '',
    size: q.get('size') ? Number(q.get('size')) : undefined,
    width: q.get('width') ? Number(q.get('width')) : undefined,
    height: q.get('height') ? Number(q.get('height')) : undefined,
  };
}
