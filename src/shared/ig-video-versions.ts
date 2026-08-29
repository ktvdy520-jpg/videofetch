/** Pure helpers for Instagram video_versions JSON (no chrome APIs). */

export const IG_URL_CHANGE_EVENT = 'tubebox-ig-urlchange';
export const IG_MEDIA_EVENT = 'tubebox-ig-media';

export interface IgVideoHit {
  code?: string;
  url: string;
  width?: number;
  height?: number;
}

/** Deep-collect video_versions[0] with nearest code/shortcode. */
export function collectVideoVersionHits(
  obj: unknown,
  inheritedCode?: string,
  out: IgVideoHit[] = [],
): IgVideoHit[] {
  if (obj == null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectVideoVersionHits(item, inheritedCode, out);
    return out;
  }
  const rec = obj as Record<string, unknown>;
  const code =
    (typeof rec.code === 'string' && rec.code) ||
    (typeof rec.shortcode === 'string' && rec.shortcode) ||
    inheritedCode;

  const versions = rec.video_versions;
  if (Array.isArray(versions) && versions.length) {
    const first = versions[0] as { url?: string; width?: number; height?: number };
    if (first?.url && typeof first.url === 'string') {
      out.push({
        code,
        url: first.url,
        width: typeof first.width === 'number' ? first.width : undefined,
        height: typeof first.height === 'number' ? first.height : undefined,
      });
    }
  }

  for (const k of Object.keys(rec)) {
    if (k === 'video_versions') continue;
    collectVideoVersionHits(rec[k], code, out);
  }
  return out;
}

/** Parse response text; return hits if it looks like IG media JSON. */
export function hitsFromResponseText(text: string): IgVideoHit[] {
  if (!text || text.length < 20 || !text.includes('video_versions')) return [];
  try {
    const data = JSON.parse(text) as unknown;
    return collectVideoVersionHits(data);
  } catch {
    return [];
  }
}
