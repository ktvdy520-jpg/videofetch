import { isFacebookPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const fetched = new Set<string>();
let navGeneration = 0;
const MARK = 'tubebox-fb-seen';

function getCookie(name: string): string | undefined {
  const parts = ('; ' + document.cookie).split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift();
  return undefined;
}

function returnNumbers(raw: string): string[] {
  return raw.match(/[\D]+(?=[_])|[\d]+_?[\d]+/g) || [];
}

function pickVideoIdFromText(raw: string): string | null {
  const nums = returnNumbers(raw);
  const id = nums.find((n) => /^\d+$/.test(n));
  return id || null;
}

/** Qooly/4saved: ?v= /videos/ /reel(s)/ / data-video-id */
function currentVideoId(): string | null {
  const search = location.search.match(/\?v=(\d+)/i)?.[1];
  if (search) return search;

  const videosPath = location.pathname.match(/\/videos\/(\d+)/i)?.[1];
  if (videosPath) return videosPath;

  const reelPath = location.pathname.match(/\/reels?\/(\d+)/i)?.[1];
  if (reelPath) return reelPath;

  const el = document.querySelector('[data-video-id]') as HTMLElement | null;
  const fromDom = el?.dataset?.videoId;
  if (fromDom && /^\d+$/.test(fromDom)) return fromDom;

  return pickVideoIdFromText(location.pathname + location.search);
}

async function resolveDtsg(): Promise<string | undefined> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_FB_DTSG' })) as {
      ok?: boolean;
      dtsg?: string;
    };
    if (res?.ok && res.dtsg) return res.dtsg;
  } catch {
    /* ignore */
  }
  return undefined;
}

async function fetchVideoData(videoId: string): Promise<PageMediaLink | null> {
  const dtsg = await resolveDtsg();
  if (!dtsg) return null;
  const user = getCookie('c_user') || '';
  const url =
    `https://www.facebook.com/video/video_data_async/?video_id=${encodeURIComponent(videoId)}` +
    `&fb_dtsg_ag=${encodeURIComponent(dtsg)}&__user=${encodeURIComponent(user)}&__a=1`;

  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  const text = await res.text();
  const data = JSON.parse(text.replace(/^for \(;;\);/, '')) as {
    payload?: { hd_src?: string; sd_src?: string };
  };
  const src = data.payload?.hd_src || data.payload?.sd_src;
  if (!src || !/^https?:\/\//i.test(src)) return null;
  return {
    url: normalizeMediaUrl(src),
    title: `video_${videoId}`,
    kind: kindFromUrl(src),
  };
}

async function resolveById(videoId: string): Promise<void> {
  if (!videoId || fetched.has(videoId)) return;
  fetched.add(videoId);
  const gen = navGeneration;
  let link: PageMediaLink | null = null;
  try {
    link = await fetchVideoData(videoId);
  } catch {
    link = null;
  }
  if (gen !== navGeneration) return;
  if (!link) {
    fetched.delete(videoId);
    return;
  }
  pushPageLinks([link]);
}

function scanWatchLinks(): void {
  for (const a of Array.from(document.querySelectorAll('a[href*="/watch"]'))) {
    if (a.classList.contains(MARK)) continue;
    const href = (a as HTMLAnchorElement).href || '';
    const m = href.match(/\/watch\/?\?v=(\d+)/i);
    if (!m?.[1]) continue;
    a.classList.add(MARK);
    void resolveById(m[1]);
  }
}

function scanVideos(): void {
  for (const video of Array.from(document.querySelectorAll('video'))) {
    if (video.classList.contains(MARK)) continue;
    video.classList.add(MARK);
    const id = currentVideoId();
    if (id) void resolveById(id);
  }
}

function softScan(): void {
  if (location.href.includes('instagram/login_sync')) return;
  const id = currentVideoId();
  if (id) void resolveById(id);
  if (/\/reels?\//i.test(location.pathname)) return;
  scanWatchLinks();
  scanVideos();
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

if (isFacebookPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  softScan();
  setInterval(softScan, 4000);
  document.addEventListener('scroll', () => softScan(), { passive: true });
}
