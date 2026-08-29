import type { MediaKind, PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

export function pushPageLinks(links: PageMediaLink[]): void {
  const cleaned = links
    .map((l) => ({
      ...l,
      url: normalizeMediaUrl(l.url),
    }))
    .filter((l) => /^https?:\/\//i.test(l.url));
  if (!cleaned.length) return;
  try {
    void chrome.runtime.sendMessage({ type: 'ADD_PAGE_MEDIA', links: cleaned });
  } catch {
    /* extension context may be invalidated */
  }
}

export function kindFromUrl(url: string): MediaKind {
  if (/\.m3u8(\?|#|$)/i.test(url)) return 'm3u8';
  return 'mp4';
}

/** Deep-collect arrays named `key` from nested JSON (Qooly searchKey style). */
export function searchKeyDeep(obj: unknown, key: string, out: unknown[] = []): unknown[] {
  if (obj == null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) searchKeyDeep(item, key, out);
    return out;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k === key && rec[k] != null) out.push(rec[k]);
    searchKeyDeep(rec[k], key, out);
  }
  return out;
}
