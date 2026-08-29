import type { ContentMessage } from '../shared/types';

export { IG_URL_CHANGE_EVENT } from '../shared/ig-video-versions';

/** Clear scan marks and invoke callback (Qooly-style reset-videos). */
export function onResetPageScan(reset: () => void, rescan: () => void): void {
  chrome.runtime.onMessage.addListener((message: ContentMessage) => {
    if (message?.type !== 'RESET_PAGE_SCAN') return;
    reset();
    rescan();
  });
}

/**
 * Detect SPA URL changes and notify background before local rescan.
 * - poll: works from isolated world (location is shared)
 * - optional page event: MAIN-world history hook (Instagram)
 */
export function watchSpaNavigation(
  onNavigate: () => void,
  options?: { pageEventName?: string },
): void {
  let last = location.href;

  const fire = () => {
    if (location.href === last) return;
    last = location.href;
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_NAVIGATED' }, () => {
        void chrome.runtime.lastError;
        onNavigate();
      });
    } catch {
      onNavigate();
    }
  };

  window.addEventListener('popstate', fire);
  setInterval(fire, 500);

  if (options?.pageEventName) {
    window.addEventListener(options.pageEventName, () => fire());
  }
}
