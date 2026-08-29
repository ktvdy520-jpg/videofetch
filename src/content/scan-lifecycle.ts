import type { ContentMessage } from '../shared/types';

/** Clear scan marks and invoke callback (Qooly-style reset-videos). */
export function onResetPageScan(reset: () => void, rescan: () => void): void {
  chrome.runtime.onMessage.addListener((message: ContentMessage) => {
    if (message?.type !== 'RESET_PAGE_SCAN') return;
    reset();
    rescan();
  });
}

/**
 * Watch SPA href changes (poll + history pushState/replaceState + popstate).
 * Instagram Reels updates the URL via history APIs without a full reload.
 */
export function watchSpaNavigation(onNavigate: () => void): void {
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

  const wrapHistory = (method: 'pushState' | 'replaceState') => {
    const original = history[method].bind(history);
    history[method] = function (...args: Parameters<History['pushState']>) {
      const ret = original(...args);
      queueMicrotask(fire);
      return ret;
    };
  };

  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', fire);
  setInterval(fire, 700);
}
