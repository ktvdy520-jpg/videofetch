/**
 * MAIN world: only history hooks for reliable SPA URL detection.
 * Reel media is fetched actively from the isolated content script (competitor approach).
 */
import { IG_URL_CHANGE_EVENT } from '../shared/ig-video-versions';

(() => {
  let lastHref = location.href;

  const notifyUrl = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    window.postMessage({ source: 'tubebox-ig', type: IG_URL_CHANGE_EVENT, href: location.href }, '*');
    window.dispatchEvent(
      new CustomEvent(IG_URL_CHANGE_EVENT, { detail: { href: location.href } }),
    );
  };

  const wrapHistory = (method: 'pushState' | 'replaceState') => {
    const original = history[method].bind(history);
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const ret = original(...args);
      queueMicrotask(notifyUrl);
      return ret;
    };
  };

  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', notifyUrl);
})();
