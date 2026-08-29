import { isDailymotionPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const fetched = new Set<string>();
let navGeneration = 0;

function videoIdFromPath(): string | null {
  if (/^\/\w{0,2}$/.test(location.pathname)) return null;
  const id = location.pathname.replace(/^\/video\//, '').replace(/^\//, '').split('/')[0];
  if (!id || !/^[\w\d]{1,32}$/i.test(id)) return null;
  return id;
}

type DmMeta = {
  title?: string;
  qualities?: Record<string, Array<{ type?: string; url?: string }>>;
};

async function fetchMeta(videoId: string): Promise<PageMediaLink | null> {
  const url = new URL(`https://www.dailymotion.com/player/metadata/video/${videoId}`);
  url.searchParams.set('app', 'com.dailymotion.neon');
  url.searchParams.set('locale', 'en');
  url.searchParams.set('client_type', 'website');

  const res = await fetch(url.href, { credentials: 'omit' });
  if (!res.ok) return null;
  const data = (await res.json()) as DmMeta;
  const title = (data.title || document.title || 'dailymotion').slice(0, 80);
  const qualities = data.qualities || {};

  // Prefer explicit height keys (1080, 720…) over auto HLS when progressive exists.
  const heightKeys = Object.keys(qualities)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => b - a);

  for (const h of heightKeys) {
    const list = qualities[String(h)] || [];
    const mp4 = list.find((q) => q.url && (!q.type || q.type.includes('mp4')));
    if (mp4?.url && /^https?:\/\//i.test(mp4.url)) {
      return {
        url: normalizeMediaUrl(mp4.url),
        title,
        kind: kindFromUrl(mp4.url),
        height: h,
      };
    }
  }

  const auto = qualities.auto?.[0]?.url;
  if (auto && /^https?:\/\//i.test(auto)) {
    return { url: normalizeMediaUrl(auto), title, kind: kindFromUrl(auto) };
  }
  return null;
}

async function resolve(videoId: string): Promise<void> {
  if (!videoId || fetched.has(videoId)) return;
  fetched.add(videoId);
  const gen = navGeneration;
  let link: PageMediaLink | null = null;
  try {
    link = await fetchMeta(videoId);
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

function softScan(): void {
  const id = videoIdFromPath();
  if (id) void resolve(id);
}

function resetState(): void {
  fetched.clear();
}

function resetAndScan(): void {
  navGeneration += 1;
  resetState();
  softScan();
}

if (isDailymotionPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  softScan();
  setInterval(softScan, 4000);
}
