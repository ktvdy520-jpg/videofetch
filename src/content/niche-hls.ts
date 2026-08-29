import { isNicheHlsPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import { normalizeMediaUrl } from '../shared/media';

/** 928hd / showhd9: script[data-name=mk] embeds hls + title (Qooly rule_1). */
const MARK = 'tubebox-niche-seen';
const fetched = new Set<string>();
let navGeneration = 0;

function extractQuoted(raw: string, key: string): string[] {
  const re = new RegExp(`(["'])?${key}(["'])?:\\s*(["'])(.*?)\\3`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m[4]) out.push(m[4]);
  }
  return out;
}

function scanScripts(root: ParentNode = document): void {
  const scripts = Array.from(root.querySelectorAll("script[data-name='mk']"));
  for (const s of scripts) {
    if (s.classList.contains(MARK)) continue;
    s.classList.add(MARK);
    const text = s.textContent || '';
    const hlsList = extractQuoted(text, 'hls');
    const titles = extractQuoted(text, 'title');
    for (let i = 0; i < hlsList.length; i++) {
      const raw = hlsList[i];
      if (!raw || !/^https?:\/\//i.test(raw)) continue;
      const url = normalizeMediaUrl(raw);
      if (fetched.has(url)) continue;
      fetched.add(url);
      pushPageLinks([
        {
          url,
          title: (titles[i] || document.title || 'video').slice(0, 80),
          kind: kindFromUrl(url),
        },
      ]);
    }
  }
}

function softScan(): void {
  scanScripts(document);
  for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
    try {
      const doc = iframe.contentDocument;
      if (doc) scanScripts(doc);
    } catch {
      /* cross-origin */
    }
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

if (isNicheHlsPage()) {
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  softScan();
  setInterval(softScan, 5000);
}
