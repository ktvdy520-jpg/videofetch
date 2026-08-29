import { isIxiguaPage } from '../shared/sniff-rules';
import { kindFromUrl, pushPageLinks } from './page-media';
import { onResetPageScan, watchSpaNavigation } from './scan-lifecycle';
import { normalizeMediaUrl } from '../shared/media';

const fetched = new Set<string>();
let navGeneration = 0;

function onMessage(ev: MessageEvent): void {
  const data = ev.data;
  if (!data || data.source !== 'tubebox-ixigua') return;
  if (data.type !== 'IXIGUA_DATA') return;
  if (!data.url || !/^https?:\/\//i.test(data.url)) return;
  const url = normalizeMediaUrl(data.url);
  if (fetched.has(url)) return;
  fetched.add(url);
  pushPageLinks([
    {
      url,
      title: String(data.title || document.title || 'ixigua').slice(0, 80),
      kind: kindFromUrl(url),
    },
  ]);
}

function resetState(): void {
  fetched.clear();
}

function resetAndScan(): void {
  navGeneration += 1;
  resetState();
  window.postMessage({ source: 'tubebox-ixigua', type: 'IXIGUA_RESCAN' }, '*');
}

if (isIxiguaPage()) {
  window.addEventListener('message', onMessage);
  onResetPageScan(resetState, resetAndScan);
  watchSpaNavigation(resetAndScan);
  window.postMessage({ source: 'tubebox-ixigua', type: 'IXIGUA_RESCAN' }, '*');
}
