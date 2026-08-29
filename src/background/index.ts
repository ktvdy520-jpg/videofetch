import type { BgMessage, BgResponse, CapturedMedia } from '../shared/types';
import { detectMediaKind, mediaId } from '../shared/media';
import { isYouTubeRelatedUrl } from '../shared/youtube';
import { buildWebDlPageUrl, DEFAULT_WEB_DL_URL } from '../shared/dl-url';
import {
  formatResolutionLabel,
  guessResolutionFromUrl,
  parseHlsPlaylist,
} from '../shared/hls-parse';

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
}

function parseContentLength(header?: string): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
    // Page may have changed while fetching.
    const still = map.get(seed.id);
    if (!still || (still.pageUrl && seed.pageUrl && !samePage(still.pageUrl, seed.pageUrl))) {
      return;
    }

    const parsed = parseHlsPlaylist(text, seed.url);
    if (parsed.isMaster && parsed.variants.length > 0) {
      map.delete(seed.id);
      for (const v of parsed.variants) {
        if (isYouTubeRelatedUrl(v.uri)) continue;
        let width = v.width;
        let height = v.height;
        if (height == null && width == null) {
          const g = guessResolutionFromUrl(v.uri);
          width = g.width;
          height = g.height;
        }
        const id = mediaId(seed.tabId, v.uri);
        const prev = map.get(id);
        const label = formatResolutionLabel(width, height);
        map.set(id, {
          id,
          url: v.uri,
          tabId: seed.tabId,
          pageUrl: seed.pageUrl,
          title: seed.title,
          kind: 'm3u8',
          mime: seed.mime,
          sizeBytes: prev?.sizeBytes,
          width: width ?? prev?.width,
          height: height ?? prev?.height,
          capturedAt: Date.now(),
          label,
        });
        enrichedPlaylists.add(enrichKey(seed.tabId, v.uri));
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

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method && details.method !== 'GET') return;

    const url = details.url;
    if (isYouTubeRelatedUrl(url)) return;

    const headers = details.responseHeaders || [];
    const ctype = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    const clen = headers.find((h) => h.name.toLowerCase() === 'content-length')?.value;
    const kind = detectMediaKind(url, ctype);
    if (!kind) return;

    const size = parseContentLength(clen);
    if (kind === 'mp4' && size != null && size < 50_000) return;

    void (async () => {
      let pageUrl = '';
      let title = 'video';
      try {
        const tab = await chrome.tabs.get(details.tabId);
        pageUrl = tab.url || '';
        title = tab.title || 'video';
        if (pageUrl && isYouTubeRelatedUrl(pageUrl)) return;
      } catch {
        return;
      }

      const map = getTabMap(details.tabId);
      // Drop leftovers from a previous document in this tab.
      for (const [id, item] of map) {
        if (item.pageUrl && pageUrl && !samePage(item.pageUrl, pageUrl)) {
          map.delete(id);
        }
      }

      const id = mediaId(details.tabId, url);
      const prev = map.get(id);
      const guessed =
        kind === 'mp4' || kind === 'm3u8' ? guessResolutionFromUrl(url) : {};
      const width = prev?.width ?? guessed.width;
      const height = prev?.height ?? guessed.height;
      const item: CapturedMedia = {
        id,
        url,
        tabId: details.tabId,
        pageUrl,
        title,
        kind,
        mime: ctype,
        sizeBytes: size ?? prev?.sizeBytes,
        width,
        height,
        capturedAt: Date.now(),
        label:
          height || width
            ? formatResolutionLabel(width, height)
            : kind === 'm3u8'
              ? 'M3U8'
              : 'MP4',
      };
      map.set(id, item);
      await updateBadge(details.tabId);

      if (kind === 'm3u8') {
        void enrichM3u8Entry(item);
      }
    })();
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  forgetEnrichment(tabId);
});

/** Same tab navigated to another page → keep only the new page's captures. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const pageUrl = changeInfo.url || tab.url || '';
  if (!pageUrl) return;

  if (isYouTubeRelatedUrl(pageUrl)) {
    tabMedia.delete(tabId);
    forgetEnrichment(tabId);
    void updateBadge(tabId);
    return;
  }

  // URL change or load cycle: drop items that belong to a different document.
  if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') {
    const map = tabMedia.get(tabId);
    if (!map || map.size === 0) return;
    let removed = false;
    for (const [id, item] of map) {
      if (item.pageUrl && !samePage(item.pageUrl, pageUrl)) {
        map.delete(id);
        removed = true;
      }
    }
    if (map.size === 0) {
      tabMedia.delete(tabId);
      forgetEnrichment(tabId);
    }
    if (removed) void updateBadge(tabId);
  }
});

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

chrome.runtime.onMessage.addListener((message: BgMessage, _sender, sendResponse) => {
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
    tabMedia.delete(message.tabId);
    forgetEnrichment(message.tabId);
    void updateBadge(message.tabId);
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

console.info('[TubeBox] background ready');
