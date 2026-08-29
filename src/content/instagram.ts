import { isInstagramPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const SEEN = new Set<string>();
const MARK = 'tubebox-ig-scanned';

/** Instagram uses both /reel/ and /reels/ (and p/tv/stories). */
const IG_MEDIA_PATH = /\/(?:reels?|p|tv|stories)\/([^/?#]+)/i;
const IG_MEDIA_PATH_TEST = /\/(?:reels?|p|tv|stories)\//i;

interface IgHit {
  code?: string;
  url: string;
  width?: number;
  height?: number;
}

function currentShortcode(): string | null {
  const m = location.pathname.match(IG_MEDIA_PATH);
  return m?.[1] ?? null;
}

function isSingleMediaRoute(): boolean {
  return IG_MEDIA_PATH_TEST.test(location.pathname);
}

function displayTitle(shortcode: string | null): string {
  const t = (document.title || '').trim();
  if (t && !/^instagram$/i.test(t)) return t.slice(0, 80);
  return shortcode ? `instagram-${shortcode}` : 'instagram';
}

/** Collect video_versions[0] with nearest code/shortcode (Qooly-style, filtered). */
function collectHits(obj: unknown, inheritedCode?: string, out: IgHit[] = []): IgHit[] {
  if (obj == null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectHits(item, inheritedCode, out);
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
    collectHits(rec[k], code, out);
  }
  return out;
}

function playingVideoUrl(): string | null {
  const videos = Array.from(document.querySelectorAll('video'));
  const playing = videos.find((v) => !v.paused && !v.ended && (v.currentSrc || v.src));
  const pick = playing || videos.find((v) => !!(v.currentSrc || v.src));
  const url = pick?.currentSrc || pick?.src || null;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function urlsLooselyEqual(a: string, b: string): boolean {
  try {
    const na = normalizeMediaUrl(a);
    const nb = normalizeMediaUrl(b);
    if (na === nb) return true;
    const pa = new URL(na).pathname;
    const pb = new URL(nb).pathname;
    return !!pa && pa === pb;
  } catch {
    return a === b;
  }
}

function resetState(): void {
  SEEN.clear();
  document.querySelectorAll('.' + MARK).forEach((el) => el.classList.remove(MARK));
}

function collectFromPage(): PageMediaLink[] {
  const shortcode = currentShortcode();
  const title = displayTitle(shortcode);
  const hits: IgHit[] = [];

  const scripts = Array.from(
    document.querySelectorAll('script[type="application/json"], script:not([src])'),
  );
  for (const el of scripts) {
    const text = el.textContent || '';
    if (!text.includes('video_versions')) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    el.classList.add(MARK);
    collectHits(data, undefined, hits);
  }

  let chosen: IgHit[] = hits;

  if (shortcode) {
    const matched = hits.filter((h) => h.code === shortcode);
    if (matched.length) chosen = matched;
  }

  const playing = playingVideoUrl();
  if (playing) {
    const byPlay = chosen.filter((h) => urlsLooselyEqual(h.url, playing));
    if (byPlay.length) {
      chosen = byPlay;
    } else if (isSingleMediaRoute() && (!chosen.length || chosen.length > 1)) {
      chosen = [{ url: playing }];
    }
  }

  const links: PageMediaLink[] = [];
  for (const hit of chosen) {
    const url = normalizeMediaUrl(hit.url);
    if (!url || SEEN.has(url)) continue;
    SEEN.add(url);
    links.push({
      url,
      title,
      kind: kindFromUrl(url),
      width: hit.width,
      height: hit.height,
    });
  }

  if (!links.length && isSingleMediaRoute() && playing) {
    const url = normalizeMediaUrl(playing);
    if (!SEEN.has(url)) {
      SEEN.add(url);
      links.push({ url, title, kind: 'mp4' });
    }
  }

  if (isSingleMediaRoute() && links.length > 1) {
    return links.slice(0, 1);
  }

  return links;
}

function scan(): void {
  if (!isInstagramPage()) return;
  const links = collectFromPage();
  if (links.length) pushPageLinks(links);
}

/** Clear + scan now, then retry after player src catches up. */
function resetAndScan(): void {
  resetState();
  scan();
  setTimeout(() => {
    resetState();
    scan();
  }, 600);
  setTimeout(() => {
    resetState();
    scan();
  }, 1500);
}

let scanQueued = false;
function scheduleScan(): void {
  if (scanQueued) return;
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scan();
  }, 800);
}

if (isInstagramPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  scan();
  setInterval(scan, 7000);
  document.addEventListener('scroll', scheduleScan, { passive: true });
  document.addEventListener('wheel', scheduleScan, { passive: true });
}
