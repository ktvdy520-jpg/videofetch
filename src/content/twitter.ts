import { isTwitterPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const fetched = new Set<string>();
let navGeneration = 0;
const MARK = 'tubebox-tw-seen';
const STATUS_RE = /\/(?:i\/web\/)?status\/(\d+)/i;

function getCookie(name: string): string | undefined {
  const parts = ('; ' + document.cookie).split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift();
  return undefined;
}

function tweetIdFromUrl(href: string = location.href): string | null {
  try {
    const path = new URL(href, location.origin).pathname;
    return path.match(STATUS_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

function tweetIdFromArticle(article: Element): string | null {
  for (const a of Array.from(article.querySelectorAll('a[href*="/status/"]'))) {
    const id = tweetIdFromUrl((a as HTMLAnchorElement).href);
    if (id) return id;
  }
  return null;
}

function pushMp4Links(
  raw: Array<{ url?: string; title?: string; width?: number; height?: number }>,
): void {
  const links: PageMediaLink[] = [];
  for (const item of raw) {
    if (!item.url || !/^https?:\/\//i.test(item.url)) continue;
    const url = normalizeMediaUrl(item.url);
    if (fetched.has(url)) continue;
    fetched.add(url);
    const kind = kindFromUrl(url);
    links.push({
      url,
      title: (item.title || document.title || 'twitter video').slice(0, 80),
      kind: kind === 'other' ? 'mp4' : kind,
      width: item.width,
      height: item.height,
      // Competitor: width from avc1/W×H as "Wp"; else n/a
      label: item.width ? `${item.width}p` : 'n/a',
      priority: item.width ? Math.max(0, 4000 - item.width) : 90,
    });
  }
  if (links.length) pushPageLinks(links);
}

/** Fallback: old conversation API (mp4 only). */
async function resolveTweet(tweetId: string): Promise<void> {
  if (!tweetId || fetched.has(`id:${tweetId}`)) return;
  fetched.add(`id:${tweetId}`);
  const gen = navGeneration;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'GET_TWITTER_VIDEO',
      tweetId,
      csrfToken: getCookie('ct0'),
    })) as { ok?: boolean; links?: PageMediaLink[] };
    if (gen !== navGeneration) return;
    if (res?.ok && res.links?.length) {
      const mp4Only = res.links.filter((l) => l.kind !== 'm3u8' && !/\.m3u8/i.test(l.url));
      if (mp4Only.length) {
        for (const l of mp4Only) {
          if (fetched.has(l.url)) continue;
          fetched.add(l.url);
        }
        pushPageLinks(mp4Only.map((l) => ({ ...l, kind: kindFromUrl(l.url), priority: 0 })));
        return;
      }
    }
  } catch {
    /* allow retry */
  }
  if (gen === navGeneration) fetched.delete(`id:${tweetId}`);
}

function softScan(): void {
  const fromUrl = tweetIdFromUrl();
  if (fromUrl) void resolveTweet(fromUrl);

  for (const video of Array.from(document.querySelectorAll('video'))) {
    if (video.classList.contains(MARK)) continue;
    video.classList.add(MARK);
    const article = video.closest('article');
    const id = article ? tweetIdFromArticle(article) : fromUrl;
    if (id) void resolveTweet(id);
  }
}

function resetState(): void {
  fetched.clear();
  document.querySelectorAll('.' + MARK).forEach((el) => el.classList.remove(MARK));
}

function resetAndScan(): void {
  navGeneration += 1;
  resetState();
  softScan();
}

if (isTwitterPage()) {
  window.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data;
    if (!data || data.source !== 'tubebox-x') return;
    if (data.type === 'VIDEO_MP4' && Array.isArray(data.links)) {
      pushMp4Links(data.links);
    }
  });

  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  softScan();
  setInterval(softScan, 3000);
  document.addEventListener('scroll', () => softScan(), { passive: true });
}
