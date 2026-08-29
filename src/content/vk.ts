import { isVkPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const QUALITIES = ['2160', '1440', '1080', '720', '480', '360', '240', '144', '130'] as const;
const fetched = new Set<string>();
let navGeneration = 0;
const MARK = 'tubebox-vk-seen';

type PlayerParams = {
  md_title?: string;
  [key: string]: unknown;
};

function videoIdFromUrl(): string | null {
  try {
    const part = location.href.split(/[/?#]/).find((t) => t.startsWith('video-') || t.startsWith('video'));
    if (!part) return null;
    if (part.startsWith('video-')) return part.slice('video-'.length);
    if (part.startsWith('video') && part.length > 5) return part.slice(5);
  } catch {
    /* ignore */
  }
  return null;
}

function bestLinkFromParams(params: PlayerParams): PageMediaLink | null {
  const title = (params.md_title || document.title || 'vk video').slice(0, 80);
  for (const q of QUALITIES) {
    const u = params[`url${q}`];
    if (typeof u === 'string' && u.startsWith('http')) {
      return {
        url: normalizeMediaUrl(u),
        title,
        kind: kindFromUrl(u),
        height: Number(q),
      };
    }
  }
  return null;
}

function parsePlayerParamsText(text: string): PageMediaLink[] {
  const m = text.match(/playerParams\s*=\s*(\{.*?\});/s);
  if (!m?.[1]) return [];
  try {
    const obj = JSON.parse(m[1]) as { params?: PlayerParams[] };
    const out: PageMediaLink[] = [];
    for (const p of obj.params || []) {
      const link = bestLinkFromParams(p);
      if (link) out.push(link);
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchByAlVideo(videoId: string): Promise<PageMediaLink | null> {
  const host = location.hostname;
  const res = await fetch(`https://${host}/al_video.php?act=show`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body:
      'al=1&autoplay=1&claim=&force_no_repeat=true&is_video_page=true&list=&module=direct&show_next=1&t=&video=' +
      encodeURIComponent(videoId),
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('windows-1251').decode(buf).replace(/^<!--/, '');
  const json = JSON.parse(text) as { payload?: unknown[] };
  const block = json.payload?.[1] as Record<string, unknown> | undefined;
  if (!block || typeof block !== 'object') return null;

  let playerObj: { player?: { params?: PlayerParams[] } } | null = null;
  for (const v of Object.values(block)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'player' in (v as object)) {
      playerObj = v as { player?: { params?: PlayerParams[] } };
      break;
    }
  }
  const params = playerObj?.player?.params?.[0];
  if (!params) return null;
  return bestLinkFromParams(params);
}

async function resolveId(videoId: string): Promise<void> {
  if (!videoId || fetched.has(videoId)) return;
  fetched.add(videoId);
  const gen = navGeneration;
  let link: PageMediaLink | null = null;
  try {
    link = await fetchByAlVideo(videoId);
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

function scanHtmlScripts(): boolean {
  for (const s of Array.from(document.querySelectorAll('script'))) {
    const text = s.textContent || '';
    if (!text.includes('playerParams')) continue;
    const links = parsePlayerParamsText(text);
    if (links.length) {
      pushPageLinks([links[0]]);
      return true;
    }
  }
  return false;
}

function scanBoxes(): void {
  for (const box of Array.from(document.querySelectorAll('.video_box_wrap'))) {
    if (box.classList.contains(MARK)) continue;
    box.classList.add(MARK);
    const raw = box.id.replace('video_box_wrap', '');
    const [oid, id] = raw.split('_');
    if (!oid || !id) continue;
    void (async () => {
      try {
        const res = await fetch(`https://vk.com/video_ext.php?oid=${oid}&id=${id}`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const text = new TextDecoder('windows-1251').decode(buf);
        const links = parsePlayerParamsText(text);
        if (links.length) pushPageLinks([links[0]]);
      } catch {
        /* ignore */
      }
    })();
  }
}

function softScan(): void {
  const id = videoIdFromUrl();
  if (id) void resolveId(id);
  if (scanHtmlScripts()) return;
  scanBoxes();
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

if (isVkPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  softScan();
  setInterval(softScan, 4000);
}
