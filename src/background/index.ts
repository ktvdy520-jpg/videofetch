import type { BgMessage, BgResponse, CapturedMedia, PageMediaLink } from '../shared/types';
import { detectMediaKind, isTooSmallMedia, mediaId, normalizeMediaUrl } from '../shared/media';
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
  isPageParserSite,
} from '../shared/sniff-rules';
import { DEFAULT_IG_APP_ID } from '../shared/ig-shortcode';

/** Latest x-ig-app-id seen on Instagram requests (competitors reuse this). */
let igAppId = DEFAULT_IG_APP_ID;

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

      // Instagram etc.: curated page parser only — skip progressive CDN noise.
      if (kind !== 'm3u8' && isPageParserSite(pageUrl)) return;

      if (kind === 'mp4' || kind === 'other') {
        if (!isMp4NetworkAllowed(url)) return;
      }
      // m3u8: allowed globally (already passed ignore checks)

      const guessed =
        kind === 'mp4' || kind === 'm3u8' ? guessResolutionFromUrl(url) : {};
      const item = await upsertMedia(details.tabId, {
        url,
        pageUrl,
        title,
        kind: kind === 'other' ? 'mp4' : kind,
        mime: ctype,
        sizeBytes: size,
        width: guessed.width,
        height: guessed.height,
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

  // Instagram (and other page-parser sites): each push replaces prior page hits
  // so delayed rescans after reel swipe don't stack old + new clips.
  if (isPageParserSite(pageUrl)) {
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

async function openDownload(media: CapturedMedia): Promise<BgResponse> {
  if (isYouTubeRelatedUrl(media.url) || (media.pageUrl && isYouTubeRelatedUrl(media.pageUrl))) {
    return { ok: false, error: '不支持 YouTube 相关链接' };
  }

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
