import { shouldSkipGenericContentScript } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import type { PageMediaLink } from '../shared/types';

const SEEN = new Set<string>();
const MARK = 'tubebox-video-seen';

function resetState(): void {
  SEEN.clear();
  document.querySelectorAll('.' + MARK).forEach((el) => el.classList.remove(MARK));
}

function scan(): void {
  if (shouldSkipGenericContentScript()) return;

  const links: PageMediaLink[] = [];

  for (const video of Array.from(document.querySelectorAll('video'))) {
    if (video.classList.contains(MARK)) continue;
    video.classList.add(MARK);

    const candidates: string[] = [];
    if (video.currentSrc) candidates.push(video.currentSrc);
    if (video.src) candidates.push(video.src);
    for (const source of Array.from(video.querySelectorAll('source'))) {
      const s = source.getAttribute('src');
      if (s) candidates.push(s);
    }

    for (const raw of candidates) {
      if (!/^https?:\/\//i.test(raw)) continue;
      if (SEEN.has(raw)) continue;
      SEEN.add(raw);
      links.push({
        url: raw,
        title: document.title || 'video',
        kind: kindFromUrl(raw),
      });
    }
  }

  document.querySelectorAll('meta[property="og:video"], meta[name="og:video"]').forEach((el) => {
    const url = el.getAttribute('content');
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (SEEN.has(url)) return;
    SEEN.add(url);
    links.push({
      url,
      title: document.title || 'video',
      kind: kindFromUrl(url),
    });
  });

  if (links.length) pushPageLinks(links);
}

function resetAndScan(): void {
  resetState();
  scan();
}

if (!shouldSkipGenericContentScript()) {
  onResetPageScan(resetState, scan);
  watchSpaNavigation(resetAndScan);

  const run = () => scan();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
  setInterval(run, 7000);
  document.addEventListener('scroll', run, { passive: true });
}
