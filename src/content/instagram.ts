import { isInstagramPage } from '../shared/sniff-rules';
import { DEFAULT_IG_APP_ID, shortcodeToMediaId } from '../shared/ig-shortcode';
import { IG_URL_CHANGE_EVENT } from '../shared/ig-video-versions';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

/** Instagram uses both /reel/ and /reels/ (and p/tv/stories). */
const IG_MEDIA_PATH = /\/(?:reels?|p|tv|stories)\/([^/?#]+)/i;
const IG_MEDIA_PATH_TEST = /\/(?:reels?|p|tv|stories)\//i;

/** shortcode → already fetched this session (cleared on reset). */
const fetched = new Set<string>();
let navGeneration = 0;
let cachedAppId = DEFAULT_IG_APP_ID;

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

function resetState(): void {
  fetched.clear();
}

async function resolveAppId(): Promise<string> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_IG_APP_ID' })) as {
      ok?: boolean;
      appId?: string;
    };
    if (res?.ok && res.appId) {
      cachedAppId = res.appId;
      return res.appId;
    }
  } catch {
    /* ignore */
  }
  return cachedAppId;
}

function linkFromVersion(
  shortcode: string,
  url: string,
  width?: number,
  height?: number,
  title?: string,
): PageMediaLink {
  return {
    url: normalizeMediaUrl(url),
    title: title || displayTitle(shortcode),
    kind: kindFromUrl(url),
    width,
    height,
  };
}

/** 4saved/Qooly: GET /api/v1/media/{pk}/info/ */
async function fetchViaMediaInfo(shortcode: string, appId: string): Promise<PageMediaLink | null> {
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId || mediaId === '0') return null;

  const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    credentials: 'include',
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      'x-ig-app-id': appId,
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    items?: Array<{
      code?: string;
      caption?: { text?: string; text_translation?: string };
      video_versions?: Array<{ url?: string; width?: number; height?: number }>;
    }>;
  };
  const item = data.items?.[0];
  const ver = item?.video_versions?.[0];
  if (!ver?.url || !/^https?:\/\//i.test(ver.url)) return null;
  const title =
    item?.caption?.text_translation ||
    item?.caption?.text ||
    displayTitle(item?.code || shortcode);
  return linkFromVersion(shortcode, ver.url, ver.width, ver.height, title);
}

/** Fallback GraphQL shortcode query (same hash family as common downloaders). */
async function fetchViaGraphql(shortcode: string, appId: string): Promise<PageMediaLink | null> {
  const variables = encodeURIComponent(JSON.stringify({ shortcode }));
  const url =
    `https://www.instagram.com/graphql/query/?query_hash=55a3c4bad29e4e20c20ff4cdfd80f5b4&variables=${variables}`;
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      'x-ig-app-id': appId,
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    data?: {
      shortcode_media?: {
        video_url?: string;
        edge_sidecar_to_children?: {
          edges?: Array<{ node?: { video_url?: string } }>;
        };
      };
    };
  };
  const media = data.data?.shortcode_media;
  const videoUrl = media?.video_url;
  if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
    return linkFromVersion(shortcode, videoUrl);
  }
  const side = media?.edge_sidecar_to_children?.edges?.[0]?.node?.video_url;
  if (side && /^https?:\/\//i.test(side)) {
    return linkFromVersion(shortcode, side);
  }
  return null;
}

async function fetchReelByShortcode(shortcode: string): Promise<void> {
  if (!shortcode || shortcode === '#' || shortcode === 'audio') return;
  if (fetched.has(shortcode)) return;
  fetched.add(shortcode);

  const gen = navGeneration;
  const appId = await resolveAppId();

  let link: PageMediaLink | null = null;
  try {
    link = await fetchViaMediaInfo(shortcode, appId);
  } catch {
    /* try fallback */
  }
  if (!link) {
    try {
      link = await fetchViaGraphql(shortcode, appId);
    } catch {
      /* ignore */
    }
  }

  if (gen !== navGeneration) return;
  if (currentShortcode() !== shortcode) return;
  if (!link) {
    // Allow retry on next scan if API failed (login wall / rate limit).
    fetched.delete(shortcode);
    return;
  }
  pushPageLinks([link]);
}

/** Address-bar driven: clear session cache and pull current reel via official media API. */
function resetAndScan(): void {
  navGeneration += 1;
  resetState();
  const code = currentShortcode();
  if (code && isSingleMediaRoute()) {
    void fetchReelByShortcode(code);
    return;
  }
}

function softScan(): void {
  const code = currentShortcode();
  if (code && isSingleMediaRoute()) {
    void fetchReelByShortcode(code);
  }
}

if (isInstagramPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan, { pageEventName: IG_URL_CHANGE_EVENT });

  // postMessage bridge from MAIN history hook (more reliable than CustomEvent alone).
  window.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data;
    if (!data || data.source !== 'tubebox-ig') return;
    if (data.type === IG_URL_CHANGE_EVENT) resetAndScan();
  });

  softScan();
  setInterval(softScan, 5000);
  document.addEventListener(
    'scroll',
    () => {
      softScan();
    },
    { passive: true },
  );
}
