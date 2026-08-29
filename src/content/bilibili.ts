import { isBilibiliPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';
import { normalizeMediaUrl } from '../shared/media';

const fetched = new Set<string>();
let navGeneration = 0;

function parseHtml(html: string): PageMediaLink[] {
  const title = document.title || 'bilibili';
  const links: PageMediaLink[] = [];

  const ready = html.match(/"readyVideoUrl"\s*:\s*"([^"]+)"/);
  if (ready?.[1] && /^https?:\/\//i.test(ready[1])) {
    const url = normalizeMediaUrl(ready[1].replace(/\\u002F/g, '/'));
    links.push({ url, title, kind: kindFromUrl(url) });
  }

  try {
    const m = html.replace(/\s/g, '').match(/playUrlInfo":(\[.*?\])/);
    if (m?.[1]) {
      const arr = JSON.parse(m[1]) as Array<{ url?: string }>;
      const u = arr?.[0]?.url;
      if (u && /^https?:\/\//i.test(u)) {
        const url = normalizeMediaUrl(u);
        links.push({ url, title, kind: kindFromUrl(url) });
      }
    }
  } catch {
    /* ignore */
  }

  return links;
}

async function scan(): Promise<void> {
  if (!location.pathname.startsWith('/video/')) return;
  const key = location.pathname;
  if (fetched.has(key)) return;
  fetched.add(key);
  const gen = navGeneration;

  let links: PageMediaLink[] = [];
  try {
    links = parseHtml(document.documentElement.innerHTML);
  } catch {
    /* ignore */
  }

  if (!links.length) {
    try {
      const res = await fetch(location.href, { credentials: 'include' });
      if (res.ok) links = parseHtml(await res.text());
    } catch {
      /* ignore */
    }
  }

  if (gen !== navGeneration) return;
  if (!links.length) {
    fetched.delete(key);
    return;
  }
  pushPageLinks([links[0]]);
}

function resetState(): void {
  fetched.clear();
}

function resetAndScan(): void {
  navGeneration += 1;
  resetState();
  void scan();
}

if (isBilibiliPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  void scan();
  setInterval(() => void scan(), 5000);
}
