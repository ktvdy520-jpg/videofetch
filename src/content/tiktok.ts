import { isTikTokPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

/** /@user/video/{id} or /video/{id} */
const VIDEO_PATH = /\/(?:@[^/]+\/)?video\/(\d+)/i;

/** video id → already pushed this session (cleared on reset). */
const fetched = new Set<string>();
let navGeneration = 0;
/** Last viewport video id we resolved (FYP URL often does not change). */
let lastVisibleId: string | null = null;

type PlayAddr = {
  Width?: number;
  Height?: number;
  UrlList?: string[];
};

type BitrateInfo = {
  PlayAddr?: PlayAddr;
};

type ItemStruct = {
  id?: string;
  desc?: string;
  video?: {
    bitrateInfo?: BitrateInfo[];
    playAddr?: string;
    downloadAddr?: string;
  };
};

type RehydrationRoot = {
  __DEFAULT_SCOPE__?: {
    'webapp.video-detail'?: {
      itemInfo?: {
        itemStruct?: ItemStruct;
      };
    };
  };
};

function displayTitle(item?: ItemStruct | null): string {
  const desc = (item?.desc || '').trim();
  if (desc) return desc.slice(0, 80);
  const t = (document.title || '').trim();
  if (t && !/^tiktok$/i.test(t)) return t.slice(0, 80);
  return item?.id ? `tiktok-${item.id}` : 'tiktok video';
}

function pickPlayUrl(item: ItemStruct): { url: string; width?: number; height?: number } | null {
  const infos = item.video?.bitrateInfo;
  if (Array.isArray(infos) && infos.length) {
    for (const info of infos) {
      const list = info.PlayAddr?.UrlList;
      if (!Array.isArray(list) || !list.length) continue;
      // Qooly/4saved: skip v16-webapp-prime (often restricted / watermarked CDN).
      const url = list.find((u) => u && !u.includes('v16-webapp-prime')) || list[0];
      if (url && /^https?:\/\//i.test(url)) {
        return {
          url: normalizeMediaUrl(url),
          width: info.PlayAddr?.Width,
          height: info.PlayAddr?.Height,
        };
      }
    }
  }
  const fallback = item.video?.playAddr || item.video?.downloadAddr;
  if (fallback && /^https?:\/\//i.test(fallback)) {
    return { url: normalizeMediaUrl(fallback) };
  }
  return null;
}

function linkFromItem(item: ItemStruct): PageMediaLink | null {
  const picked = pickPlayUrl(item);
  if (!picked) return null;
  return {
    url: picked.url,
    title: displayTitle(item),
    kind: kindFromUrl(picked.url),
    width: picked.width,
    height: picked.height,
  };
}

function parseRehydrationJson(raw: unknown): PageMediaLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as RehydrationRoot;
  const item = root.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  if (!item) return null;
  return linkFromItem(item);
}

function readRehydrationFromDocument(doc: Document = document): PageMediaLink | null {
  const el = doc.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (!el?.textContent?.trim()) return null;
  try {
    return parseRehydrationJson(JSON.parse(el.textContent.trim()));
  } catch {
    return null;
  }
}

function videoIdFromPath(pathname: string = location.pathname): string | null {
  const m = pathname.match(VIDEO_PATH);
  return m?.[1] ?? null;
}

function isInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
}

/** Author unique id from detail chrome (Qooly: data-e2e author fields). */
function currentAuthorHandle(): string | null {
  const unique = document.querySelector('[data-e2e="video-author-uniqueid"]');
  const text = unique?.textContent?.trim();
  if (text) return text.replace(/^@/, '');

  const avatar = document.querySelector(
    '[data-e2e="video-author-avatar"]',
  ) as HTMLAnchorElement | null;
  const href = avatar?.getAttribute('href') || avatar?.href || '';
  const m = href.match(/\/@([^/?#]+)/);
  if (m?.[1]) return m[1];
  return null;
}

function resetState(): void {
  fetched.clear();
  lastVisibleId = null;
}

async function fetchVideoPage(pageUrl: string): Promise<PageMediaLink | null> {
  const res = await fetch(pageUrl, {
    credentials: 'include',
    headers: { Accept: 'text/html' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return readRehydrationFromDocument(doc);
}

async function resolveByVideoId(videoId: string, author?: string | null): Promise<void> {
  if (!videoId || fetched.has(videoId)) return;
  fetched.add(videoId);

  const gen = navGeneration;
  let link: PageMediaLink | null = null;

  // On the matching detail URL, prefer in-page JSON first (no extra request).
  if (videoIdFromPath() === videoId) {
    link = readRehydrationFromDocument();
  }

  if (!link) {
    const handle = (author || currentAuthorHandle() || '').replace(/^@/, '');
    const candidates: string[] = [];
    if (handle) {
      candidates.push(`https://www.tiktok.com/@${handle}/video/${videoId}`);
    }
    // Path may already be /@x/video/id — try current origin+pathname.
    if (VIDEO_PATH.test(location.pathname) && videoIdFromPath() === videoId) {
      candidates.unshift(`${location.origin}${location.pathname}`);
    }
    candidates.push(`https://www.tiktok.com/video/${videoId}`);

    for (const url of candidates) {
      try {
        link = await fetchVideoPage(url);
      } catch {
        link = null;
      }
      if (link) break;
    }
  }

  if (gen !== navGeneration) return;
  if (!link) {
    fetched.delete(videoId);
    return;
  }
  lastVisibleId = videoId;
  pushPageLinks([link]);
}

/** Detail page: address-bar video id. */
function scanDetailRoute(): void {
  const id = videoIdFromPath();
  if (!id) return;
  void resolveByVideoId(id);
}

/**
 * FYP / feed: visible xgwrapper-{uuid}-{awemeId} (same as Qooly/4saved).
 * URL often stays /foryou while the playing id changes.
 */
function scanVisibleWrappers(): void {
  const wrappers = Array.from(document.querySelectorAll('[id^="xgwrapper"]'));
  for (const el of wrappers) {
    if (!isInViewport(el)) continue;
    const parts = el.id.split('-');
    const videoId = parts[2];
    if (!videoId || !/^\d+$/.test(videoId)) continue;
    if (videoId === lastVisibleId && fetched.has(videoId)) return;
    void resolveByVideoId(videoId, currentAuthorHandle());
    return;
  }
}

function resetAndScan(): void {
  navGeneration += 1;
  resetState();
  softScan();
}

function softScan(): void {
  if (videoIdFromPath()) {
    scanDetailRoute();
    return;
  }
  scanVisibleWrappers();
}

if (isTikTokPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);

  softScan();
  setInterval(softScan, 2500);
  document.addEventListener('scroll', () => softScan(), { passive: true });
}
