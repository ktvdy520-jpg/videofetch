import { isFacebookPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const fetched = new Set<string>();
let navGeneration = 0;
/** Address-bar / primary watch id (Qooly currentPostId). */
let currentPostId: string | null = null;
const MARK = 'tubebox-fb-seen';

function getCookie(name: string): string | undefined {
  const parts = ('; ' + document.cookie).split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift();
  return undefined;
}

/** Prefer explicit ?v= via URLSearchParams (handles &rdid=… etc.). */
function videoIdFromHref(href: string = location.href): string | null {
  try {
    const u = new URL(href, location.origin);
    const v = u.searchParams.get('v');
    if (v && /^\d+$/.test(v)) return v;

    const videosPath = u.pathname.match(/\/videos\/(\d+)/i)?.[1];
    if (videosPath) return videosPath;

    const reelPath = u.pathname.match(/\/reels?\/(\d+)/i)?.[1];
    if (reelPath) return reelPath;
  } catch {
    /* ignore */
  }
  return null;
}

function currentVideoId(): string | null {
  const fromUrl = videoIdFromHref();
  if (fromUrl) return fromUrl;

  const el = document.querySelector('[data-video-id]') as HTMLElement | null;
  const fromDom = el?.dataset?.videoId;
  if (fromDom && /^\d+$/.test(fromDom)) return fromDom;

  return null;
}

function scrapeDtsgFromPage(): string | undefined {
  const input = document.querySelector('input[name="fb_dtsg"]') as HTMLInputElement | null;
  if (input?.value) return input.value;

  const html = document.documentElement.innerHTML;
  const m =
    html.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
    html.match(/"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
    html.match(/fb_dtsg_ag["']?\s*[:=]\s*["']([^"']+)["']/);
  return m?.[1];
}

async function resolveDtsg(): Promise<string | undefined> {
  const fromPage = scrapeDtsgFromPage();
  if (fromPage) return fromPage;

  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_FB_DTSG' })) as {
      ok?: boolean;
      dtsg?: string;
    };
    if (res?.ok && res.dtsg) return res.dtsg;
  } catch {
    /* ignore */
  }

  // Qooly: wait briefly for an ajax request to expose fb_dtsg_ag.
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_FB_DTSG' })) as {
      ok?: boolean;
      dtsg?: string;
    };
    if (res?.ok && res.dtsg) return res.dtsg;
  } catch {
    /* ignore */
  }
  return scrapeDtsgFromPage();
}

type FbPayload = {
  hd_src?: string;
  sd_src?: string;
  hd_src_no_ratelimit?: string;
  sd_src_no_ratelimit?: string;
};

async function fetchVideoData(
  videoId: string,
  isPrimary: boolean,
): Promise<PageMediaLink | null> {
  const dtsg = await resolveDtsg();
  if (!dtsg) return null;
  const user = getCookie('c_user') || '';
  const url =
    `https://www.facebook.com/video/video_data_async/?video_id=${encodeURIComponent(videoId)}` +
    `&fb_dtsg_ag=${encodeURIComponent(dtsg)}&__user=${encodeURIComponent(user)}&__a=1`;

  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  const text = await res.text();
  const data = JSON.parse(text.replace(/^for \(;;\);/, '')) as { payload?: FbPayload };
  const p = data.payload;
  const src =
    p?.hd_src_no_ratelimit || p?.hd_src || p?.sd_src_no_ratelimit || p?.sd_src;
  if (!src || !/^https?:\/\//i.test(src)) return null;

  const quality = p?.hd_src_no_ratelimit || p?.hd_src ? 'HD' : 'SD';
  const title = isPrimary
    ? (document.title || '').trim().slice(0, 80) || `video_${videoId}`
    : `video_${videoId}`;

  return {
    url: normalizeMediaUrl(src),
    title,
    kind: kindFromUrl(src),
    label: quality,
    priority: isPrimary ? 0 : 10,
  };
}

async function resolveById(videoId: string, isPrimary = false): Promise<void> {
  if (!videoId || fetched.has(videoId)) return;
  fetched.add(videoId);
  const gen = navGeneration;
  let link: PageMediaLink | null = null;
  try {
    link = await fetchVideoData(videoId, isPrimary || videoId === currentPostId);
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

/** Qooly searchLinks: every /watch/?v= on the page. */
function scanWatchLinks(): void {
  for (const a of Array.from(document.querySelectorAll('a[href*="watch"]'))) {
    if (a.classList.contains(MARK)) continue;
    const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
    const id = videoIdFromHref(href);
    if (!id) continue;
    a.classList.add(MARK);
    void resolveById(id, id === currentPostId);
  }
}

function scanVideos(): void {
  for (const video of Array.from(document.querySelectorAll('video'))) {
    if (video.classList.contains(MARK)) continue;
    video.classList.add(MARK);
    const id = currentVideoId();
    if (id) void resolveById(id, id === currentPostId);
  }
}

function softScan(): void {
  if (location.href.includes('instagram/login_sync')) return;

  const id = currentVideoId();
  currentPostId = id;

  // Reels: only address-bar id (Qooly early-return).
  if (/\/reels?\//i.test(location.pathname)) {
    if (id) void resolveById(id, true);
    return;
  }

  if (id) void resolveById(id, true);
  scanWatchLinks();
  scanVideos();
}

function resetState(): void {
  fetched.clear();
  currentPostId = null;
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
