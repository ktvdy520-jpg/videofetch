import type { BgMessage, BgResponse, CapturedMedia, PageMediaLink } from '../shared/types';
import {
  detectMediaKind,
  guessFilename,
  isTooSmallMedia,
  mediaId,
  normalizeMediaUrl,
} from '../shared/media';
import { isYouTubeRelatedUrl } from '../shared/youtube';
import { buildWebDlPageUrl, DEFAULT_WEB_DL_URL } from '../shared/dl-url';
import {
  formatResolutionLabel,
  guessResolutionFromUrl,
  parseHlsPlaylist,
} from '../shared/hls-parse';
import {
  isIgnoredNetworkUrl,
  isMp4NetworkAllowed,
  isPageParserReplaceSite,
  isPageParserSite,
  isTwitterSiteUrl,
  isTwitterTwimgProgressive,
} from '../shared/sniff-rules';
import { DEFAULT_IG_APP_ID } from '../shared/ig-shortcode';

/** Latest x-ig-app-id seen on Instagram requests (competitors reuse this). */
let igAppId = DEFAULT_IG_APP_ID;
/** Latest fb_dtsg_ag from Facebook video/ajax requests (Qooly/4saved). */
let fbDtsg: string | undefined;

/** Public Twitter web bearer (same family as common downloaders / Qooly). */
const TWITTER_BEARER =
  'AAAAAAAAAAAAAAAAAAAAAPYXBAAAAAAACLXUNDekMxqa8h%2F40K4moUkGsoc%3DTYfbDKbT3jJPCEVnMYqilB28NHfOPqkca3qaAxGfsyKCs0wRbw';

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    for (const h of headers) {
      if (h.name.toLowerCase() === 'x-ig-app-id' && h.value) {
        igAppId = h.value;
        break;
      }
    }
  },
  { urls: ['*://*.instagram.com/*', '*://instagram.com/*'] },
  ['requestHeaders'],
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const token = new URL(details.url).searchParams.get('fb_dtsg_ag');
      if (token && token !== fbDtsg) fbDtsg = token;
    } catch {
      /* ignore */
    }
  },
  {
    urls: [
      '*://*.facebook.com/video/video_data_async/*',
      '*://*.facebook.com/ajax/*',
      '*://facebook.com/video/video_data_async/*',
      '*://facebook.com/ajax/*',
    ],
  },
  ['requestHeaders'],
);

/** tabId -> media id -> item */
const tabMedia = new Map<number, Map<string, CapturedMedia>>();
/** Avoid re-fetching the same playlist repeatedly. */
const enrichInFlight = new Set<string>();
const enrichedPlaylists = new Set<string>();

function enrichKey(tabId: number, url: string): string {
  return `${tabId}:${url}`;
}

function forgetEnrichment(tabId: number): void {
  const prefix = `${tabId}:`;
  for (const k of [...enrichedPlaylists]) {
    if (k.startsWith(prefix)) enrichedPlaylists.delete(k);
  }
  for (const k of [...enrichInFlight]) {
    if (k.startsWith(prefix)) enrichInFlight.delete(k);
  }
}

function getTabMap(tabId: number): Map<string, CapturedMedia> {
  let m = tabMedia.get(tabId);
  if (!m) {
    m = new Map();
    tabMedia.set(tabId, m);
  }
  return m;
}

function listForTab(tabId: number, pageUrl?: string): CapturedMedia[] {
  const m = tabMedia.get(tabId);
  if (!m) return [];
  let items = Array.from(m.values());
  if (pageUrl) {
    items = items.filter((it) => !it.pageUrl || samePage(it.pageUrl, pageUrl));
  }
  return items.sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pa !== pb) return pa - pb;
    const ha = a.height ?? 0;
    const hb = b.height ?? 0;
    if (hb !== ha) return hb - ha;
    return b.capturedAt - a.capturedAt;
  });
}

async function updateBadge(tabId: number): Promise<void> {
  let pageUrl = '';
  try {
    pageUrl = (await chrome.tabs.get(tabId)).url || '';
  } catch {
    /* ignore */
  }
  const n = listForTab(tabId, pageUrl || undefined).length;
  const text = n > 0 ? String(n) : '';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#10B981' });
  } catch {
    /* tab may be gone */
  }
  notifyListChanged(tabId);
}

/** Tell an open popup to reload the sniff list (no-op if popup closed). */
function notifyListChanged(tabId: number): void {
  try {
    chrome.runtime.sendMessage({ type: 'MEDIA_LIST_CHANGED', tabId }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* ignore */
  }
}

function parseContentLength(header?: string): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Compare document pages ignoring hash (hash-only changes keep list). */
function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      ua.pathname === ub.pathname &&
      ua.search === ub.search
    );
  } catch {
    return a === b;
  }
}

function pruneStaleItems(tabId: number, pageUrl: string): void {
  const map = tabMedia.get(tabId);
  if (!map || !pageUrl) return;
  for (const [id, item] of map) {
    if (item.pageUrl && !samePage(item.pageUrl, pageUrl)) {
      map.delete(id);
    }
  }
}

async function upsertMedia(
  tabId: number,
  partial: {
    url: string;
    pageUrl: string;
    title: string;
    kind: CapturedMedia['kind'];
    mime?: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    label?: string;
    source?: CapturedMedia['source'];
    id?: string;
    capturedAt?: number;
    priority?: number;
  },
): Promise<CapturedMedia> {
  const url = normalizeMediaUrl(partial.url);
  const map = getTabMap(tabId);
  if (partial.pageUrl) pruneStaleItems(tabId, partial.pageUrl);

  const id = partial.id ?? mediaId(tabId, url);
  const prev = map.get(id);
  const item: CapturedMedia = {
    id,
    url,
    tabId,
    pageUrl: partial.pageUrl,
    title: partial.title || prev?.title || 'video',
    kind: partial.kind,
    mime: partial.mime ?? prev?.mime,
    sizeBytes:
      partial.sizeBytes != null && prev?.sizeBytes != null
        ? Math.max(partial.sizeBytes, prev.sizeBytes)
        : (partial.sizeBytes ?? prev?.sizeBytes),
    width: partial.width ?? prev?.width,
    height: partial.height ?? prev?.height,
    capturedAt: prev?.capturedAt ?? partial.capturedAt ?? Date.now(),
    label:
      partial.label ??
      (partial.height || partial.width
        ? formatResolutionLabel(partial.width, partial.height)
        : prev?.label) ??
      (partial.kind === 'm3u8' ? 'M3U8' : 'MP4'),
    source: partial.source ?? prev?.source ?? 'network',
    priority: partial.priority ?? prev?.priority,
  };
  map.set(id, item);
  await updateBadge(tabId);
  return item;
}

async function enrichM3u8Entry(seed: CapturedMedia): Promise<void> {
  const key = enrichKey(seed.tabId, seed.url);
  if (enrichedPlaylists.has(key) || enrichInFlight.has(key)) return;
  enrichInFlight.add(key);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let text: string;
    try {
      const res = await fetch(seed.url, {
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const map = tabMedia.get(seed.tabId);
    if (!map) return;
    const still = map.get(seed.id);
    if (!still || (still.pageUrl && seed.pageUrl && !samePage(still.pageUrl, seed.pageUrl))) {
      return;
    }

    const parsed = parseHlsPlaylist(text, seed.url);
    if (parsed.isMaster && parsed.variants.length > 0) {
      map.delete(seed.id);
      for (const v of parsed.variants) {
        if (isYouTubeRelatedUrl(v.uri) || isIgnoredNetworkUrl(v.uri)) continue;
        let width = v.width;
        let height = v.height;
        if (height == null && width == null) {
          const g = guessResolutionFromUrl(v.uri);
          width = g.width;
          height = g.height;
        }
        const normalized = normalizeMediaUrl(v.uri);
        const id = mediaId(seed.tabId, normalized);
        const prev = map.get(id);
        map.set(id, {
          id,
          url: normalized,
          tabId: seed.tabId,
          pageUrl: seed.pageUrl,
          title: seed.title,
          kind: 'm3u8',
          mime: seed.mime,
          sizeBytes: prev?.sizeBytes,
          width: width ?? prev?.width,
          height: height ?? prev?.height,
          capturedAt: Date.now(),
          label: formatResolutionLabel(width, height),
          source: 'network',
        });
        enrichedPlaylists.add(enrichKey(seed.tabId, normalized));
      }
      enrichedPlaylists.add(key);
      await updateBadge(seed.tabId);
      return;
    }

    const g = guessResolutionFromUrl(seed.url);
    const width = still.width ?? g.width;
    const height = still.height ?? g.height;
    map.set(seed.id, {
      ...still,
      width,
      height,
      label: formatResolutionLabel(width, height),
    });
    enrichedPlaylists.add(key);
    await updateBadge(seed.tabId);
  } catch {
    /* leave entry without resolution */
  } finally {
    enrichInFlight.delete(key);
  }
}

/**
 * Network sniff (Qooly-aligned):
 * - M3U8: global (minus ignore hosts)
 * - Progressive MP4/webm: allowlist hosts only
 * - Page-parser sites (Instagram): no progressive network capture
 */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method && details.method !== 'GET') return;
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;

    const rawUrl = details.url;
    if (isYouTubeRelatedUrl(rawUrl) || isIgnoredNetworkUrl(rawUrl)) return;
    if (details.initiator && isIgnoredNetworkUrl(details.initiator)) return;

    const url = normalizeMediaUrl(rawUrl);
    if (isYouTubeRelatedUrl(url) || isIgnoredNetworkUrl(url)) return;

    const headers = details.responseHeaders || [];
    const ctype = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    const clen = headers.find((h) => h.name.toLowerCase() === 'content-length')?.value;
    const kind = detectMediaKind(url, ctype);
    if (!kind) return;

    const size = parseContentLength(clen);
    if (isTooSmallMedia(size)) return;

    void (async () => {
      let pageUrl = '';
      let title = 'video';
      try {
        const tab = await chrome.tabs.get(details.tabId);
        pageUrl = tab.url || '';
        title = tab.title || 'video';
        if (pageUrl && (isYouTubeRelatedUrl(pageUrl) || isIgnoredNetworkUrl(pageUrl))) return;
      } catch {
        return;
      }

      // Page-parser sites: skip blanket progressive CDN noise.
      // X/Twitter exception (Qooly): still sniff video.twimg.com pl/avc1|mp4a MP4s; never M3U8.
      if (isPageParserSite(pageUrl)) {
        if (isTwitterSiteUrl(pageUrl)) {
          if (kind === 'm3u8') return;
          if (kind === 'mp4' || kind === 'other') {
            if (!isTwitterTwimgProgressive(url)) return;
          } else {
            return;
          }
        } else if (kind !== 'm3u8') {
          return;
        }
      }

      if (kind === 'mp4' || kind === 'other') {
        if (!isMp4NetworkAllowed(url) && !isTwitterTwimgProgressive(url)) return;
      }
      // m3u8: allowed globally except Twitter (handled above)

      const guessed =
        kind === 'mp4' || kind === 'm3u8' ? guessResolutionFromUrl(url) : {};
      const twimg = isTwitterSiteUrl(pageUrl) && isTwitterTwimgProgressive(url);
      // Match Qooly: label from avc1 width (e.g. 720p); missing → n/a
      const avc = twimg ? /avc1\/(\d{3,4})x(\d{3,4})/i.exec(url) : null;
      const twWidth = avc ? Number(avc[1]) : guessed.width;
      const twHeight = avc ? Number(avc[2]) : guessed.height;
      const item = await upsertMedia(details.tabId, {
        url,
        pageUrl,
        title,
        kind: kind === 'other' ? 'mp4' : kind,
        mime: ctype,
        sizeBytes: size,
        width: twWidth ?? guessed.width,
        height: twHeight ?? guessed.height,
        label: twimg ? (twWidth ? `${twWidth}p` : 'n/a') : undefined,
        priority: twimg ? (twWidth ? Math.max(0, 4000 - twWidth) : 90) : undefined,
        source: 'network',
      });

      if (item.kind === 'm3u8') {
        void enrichM3u8Entry(item);
      }
    })();
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
);

async function addPageMedia(
  tabId: number,
  pageUrl: string,
  title: string,
  links: PageMediaLink[],
): Promise<void> {
  if (!links.length) return;
  if (pageUrl && (isYouTubeRelatedUrl(pageUrl) || isIgnoredNetworkUrl(pageUrl))) return;

  // IG/TikTok: replace prior page hits so reel swipe doesn't stack clips.
  // Facebook/X/etc.: accumulate like Qooly (related watch links stay in list).
  if (isPageParserReplaceSite(pageUrl)) {
    const map = getTabMap(tabId);
    for (const [id, item] of map) {
      if (item.source === 'page') map.delete(id);
    }
  }

  for (const link of links) {
    if (!link.url || isYouTubeRelatedUrl(link.url) || isIgnoredNetworkUrl(link.url)) continue;
    const kind = link.kind ?? detectMediaKind(link.url) ?? 'mp4';
    if (kind === 'other') continue;
    const guessed = guessResolutionFromUrl(link.url);
    const item = await upsertMedia(tabId, {
      url: link.url,
      pageUrl,
      title: link.title || title || 'video',
      kind,
      width: link.width ?? guessed.width,
      height: link.height ?? guessed.height,
      label: link.label,
      priority: link.priority,
      source: 'page',
    });
    if (item.kind === 'm3u8') void enrichM3u8Entry(item);
  }
}

async function clearTabMedia(tabId: number): Promise<void> {
  tabMedia.delete(tabId);
  forgetEnrichment(tabId);
  await updateBadge(tabId);
}

function notifyContentRescan(tabId: number): void {
  chrome.tabs.sendMessage(tabId, { type: 'RESET_PAGE_SCAN' }, () => {
    void chrome.runtime.lastError;
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  forgetEnrichment(tabId);
});

/** Qooly-style: URL change → wipe list and tell page to scan again. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  const pageUrl = changeInfo.url || tab.url || '';
  if (!pageUrl) return;

  if (isYouTubeRelatedUrl(pageUrl) || isIgnoredNetworkUrl(pageUrl)) {
    void clearTabMedia(tabId);
    return;
  }

  void clearTabMedia(tabId);
  notifyContentRescan(tabId);
});

function progressiveDownloadFilename(media: CapturedMedia): string {
  const parts = [media.title || 'video'];
  if (media.label && !/^(MP4|M3U8)$/i.test(media.label)) {
    parts.push(media.label);
  }
  return guessFilename(parts.join(' '), 'mp4', media.url);
}

async function openDownload(media: CapturedMedia): Promise<BgResponse> {
  if (isYouTubeRelatedUrl(media.url) || (media.pageUrl && isYouTubeRelatedUrl(media.pageUrl))) {
    return { ok: false, error: '不支持 YouTube 相关链接' };
  }

  // Progressive MP4: extension downloads API (avoids GitHub Pages CORS / CDN hotlink 403).
  if (media.kind !== 'm3u8') {
    try {
      await chrome.downloads.download({
        url: media.url,
        filename: progressiveDownloadFilename(media),
        conflictAction: 'uniquify',
        saveAs: false,
      });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg || '下载失败' };
    }
  }

  // M3U8 / HLS: still need in-browser remux page.
  let pageBase = DEFAULT_WEB_DL_URL;
  try {
    const data = await chrome.storage.sync.get('downloadBaseUrl');
    const custom = typeof data.downloadBaseUrl === 'string' ? data.downloadBaseUrl.trim() : '';
    if (custom) pageBase = custom;
  } catch {
    /* keep default GitHub Pages */
  }

  const finalUrl = buildWebDlPageUrl(media, pageBase);
  await chrome.tabs.create({ url: finalUrl });
  return { ok: true };
}

/** Qooly: api.twitter.com conversation timeline → mp4 variants (highest first). */
async function fetchTwitterVideoLinks(
  tweetId: string,
  csrfToken?: string,
): Promise<PageMediaLink[]> {
  const url = new URL(`https://api.twitter.com/2/timeline/conversation/${tweetId}.json`);
  const params: Record<string, string> = {
    include_profile_interstitial_type: '1',
    include_blocking: '1',
    include_blocked_by: '1',
    include_followed_by: '1',
    include_want_retweets: '1',
    include_mute_edge: '1',
    include_can_dm: '1',
    include_can_media_tag: '1',
    skip_status: '1',
    cards_platform: 'Web-12',
    include_cards: '1',
    include_composer_source: 'true',
    include_ext_alt_text: 'true',
    include_reply_count: '1',
    tweet_mode: 'extended',
    include_entities: 'true',
    include_user_entities: 'true',
    include_ext_media_color: 'true',
    include_ext_media_availability: 'true',
    send_error_codes: 'true',
    simple_quoted_tweets: 'true',
    count: '20',
    ext: 'mediaStats,highlightedLabel,cameraMoment',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${TWITTER_BEARER}`,
  };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(url.href, { method: 'GET', headers, credentials: 'omit' });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    globalObjects?: {
      tweets?: Record<
        string,
        {
          full_text?: string;
          extended_entities?: {
            media?: Array<{
              video_info?: {
                variants?: Array<{ content_type?: string; url?: string; bitrate?: number }>;
              };
            }>;
          };
        }
      >;
    };
  };

  const tweet = data.globalObjects?.tweets?.[tweetId];
  const variants = tweet?.extended_entities?.media?.[0]?.video_info?.variants || [];
  const title = (tweet?.full_text || 'twitter video').slice(0, 80);
  const mp4s = variants
    .filter((v) => {
      if (!v.url || !/^https?:\/\//i.test(v.url)) return false;
      return v.content_type !== 'application/x-mpegURL';
    })
    .map((v) => {
      const m = v.url!.match(/avc1\/(\d{3,4})x(\d{3,4})/);
      const width = m ? Number(m[1]) : undefined;
      const height = m ? Number(m[2]) : undefined;
      return {
        url: normalizeMediaUrl(v.url!),
        title,
        kind: (/\.m3u8(\?|#|$)/i.test(v.url!) ? 'm3u8' : 'mp4') as 'mp4' | 'm3u8',
        width,
        height,
        label: width ? `${width}p` : 'n/a',
        priority: width ? Math.max(0, 4000 - width) : 90,
        bitrate: v.bitrate || 0,
      };
    })
    .sort((a, b) => (b.width || 0) - (a.width || 0) || b.bitrate - a.bitrate);

  return mp4s.map(({ bitrate: _b, ...link }) => link);
}

chrome.runtime.onMessage.addListener((message: BgMessage, sender, sendResponse) => {
  if (message.type === 'ADD_PAGE_MEDIA') {
    const tabId = sender.tab?.id;
    if (tabId == null || tabId < 0) {
      sendResponse({ ok: false, error: 'no tab' } satisfies BgResponse);
      return false;
    }
    void (async () => {
      let pageUrl = sender.tab?.url || '';
      let title = sender.tab?.title || 'video';
      try {
        const tab = await chrome.tabs.get(tabId);
        pageUrl = tab.url || pageUrl;
        title = tab.title || title;
      } catch {
        /* use sender */
      }
      await addPageMedia(tabId, pageUrl, title, message.links);
      sendResponse({ ok: true } satisfies BgResponse);
    })();
    return true;
  }

  if (message.type === 'PAGE_NAVIGATED') {
    const tabId = sender.tab?.id;
    if (tabId != null && tabId >= 0) {
      void clearTabMedia(tabId);
    }
    sendResponse({ ok: true } satisfies BgResponse);
    return false;
  }

  if (message.type === 'GET_IG_APP_ID') {
    sendResponse({ ok: true, appId: igAppId } satisfies BgResponse);
    return false;
  }

  if (message.type === 'GET_FB_DTSG') {
    sendResponse({ ok: true, dtsg: fbDtsg } satisfies BgResponse);
    return false;
  }

  if (message.type === 'GET_TWITTER_VIDEO') {
    void (async () => {
      try {
        const links = await fetchTwitterVideoLinks(message.tweetId, message.csrfToken);
        sendResponse({ ok: true, links } satisfies BgResponse);
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : 'twitter fetch failed',
        } satisfies BgResponse);
      }
    })();
    return true;
  }

  if (message.type === 'RESYNC_TAB') {
    void (async () => {
      await clearTabMedia(message.tabId);
      notifyContentRescan(message.tabId);
      // Give content scripts a moment to push fresh links.
      await new Promise((r) => setTimeout(r, 700));
      let pageUrl = '';
      try {
        pageUrl = (await chrome.tabs.get(message.tabId)).url || '';
      } catch {
        /* ignore */
      }
      sendResponse({
        ok: true,
        items: listForTab(message.tabId, pageUrl || undefined),
      } satisfies BgResponse);
    })();
    return true;
  }

  if (message.type === 'GET_MEDIA_FOR_TAB') {
    void (async () => {
      let pageUrl = '';
      try {
        pageUrl = (await chrome.tabs.get(message.tabId)).url || '';
      } catch {
        /* ignore */
      }
      sendResponse({
        ok: true,
        items: listForTab(message.tabId, pageUrl || undefined),
      } satisfies BgResponse);
    })();
    return true;
  }

  if (message.type === 'REMOVE_MEDIA') {
    tabMedia.get(message.tabId)?.delete(message.id);
    void updateBadge(message.tabId);
    sendResponse({ ok: true } satisfies BgResponse);
    return false;
  }

  if (message.type === 'CLEAR_TAB') {
    void clearTabMedia(message.tabId);
    sendResponse({ ok: true } satisfies BgResponse);
    return false;
  }

  if (message.type === 'OPEN_DOWNLOAD') {
    void openDownload(message.media).then(sendResponse);
    return true;
  }

  sendResponse({ ok: false, error: 'unknown message' } satisfies BgResponse);
  return false;
});

console.info('[TubeBox] background ready (qooly-aligned sniff)');
