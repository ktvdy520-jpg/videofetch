import { isTwitterPage } from '../shared/sniff-rules';
import { pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';

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

async function resolveTweet(tweetId: string): Promise<void> {
  if (!tweetId || fetched.has(tweetId)) return;
  fetched.add(tweetId);
  const gen = navGeneration;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'GET_TWITTER_VIDEO',
      tweetId,
      csrfToken: getCookie('ct0'),
    })) as { ok?: boolean; links?: PageMediaLink[] };
    if (gen !== navGeneration) return;
    if (res?.ok && res.links?.length) {
      pushPageLinks(res.links);
      return;
    }
  } catch {
    /* allow retry */
  }
  if (gen === navGeneration) fetched.delete(tweetId);
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
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  softScan();
  setInterval(softScan, 3000);
  document.addEventListener('scroll', () => softScan(), { passive: true });
}
