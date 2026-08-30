/**
 * Sniff policy aligned with Qooly-style architecture:
 * - Progressive MP4/webm: allowlist only (not every CDN hit)
 * - M3U8: global, with initiator/url ignore list
 * - Site-specific pages: content scripts, not blanket MP4 sniff
 */

/** Progressive file capture only when request URL host matches one of these. */
export const MP4_HOST_ALLOWLIST: readonly string[] = [
  'youku.com',
  'ixigua.com',
  'bastyon.com',
  'hugh.cdn.rumble.cloud',
  'rumble.com',
  'douyin.com',
  'zjcdn.com',
  'wistia.com',
  'xiaohongshu.com',
  'xhscdn.com',
];

/** Extra progressive CDN patterns (host regex). */
export const MP4_HOST_ALLOW_REGEX: readonly RegExp[] = [
  /^v\d+-xg-web-pc\.ixigua\.com$/i,
];

/**
 * Qooly: progressive Twitter CDN paths (pl/avc1 or pl/mp4a under video.twimg.com).
 * Used when the page is x.com/twitter.com so page-parser sites can still sniff these.
 */
export function isTwitterTwimgProgressive(mediaUrl: string): boolean {
  try {
    const u = new URL(mediaUrl);
    const host = u.hostname.toLowerCase();
    if (host !== 'video.twimg.com' && !host.endsWith('.video.twimg.com')) return false;
    return /\/pl\/(avc1|mp4a)\//i.test(u.pathname) || /\/avc1\/\d{3,4}x\d{3,4}\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Do not sniff network media when page or media URL matches these. */
export const NETWORK_IGNORE_HOST_REGEX: readonly RegExp[] = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)googlevideo\.com$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)vimeocdn\.com$/i,
  /(^|\.)globo\.com$/i,
];

/** Hosts that use page parsers instead of progressive network sniff. */
export const PAGE_PARSER_HOSTS: readonly string[] = [
  'instagram.com',
  'cdninstagram.com',
  'tiktok.com',
  'facebook.com',
  'fb.com',
  'twitter.com',
  'x.com',
  'bilibili.com',
  'dailymotion.com',
  'vk.com',
  'vkvideo.ru',
  'ixigua.com',
  '928hd.tv',
  'showhd9.com',
];

/**
 * Page parsers that keep only the latest push (SPA one-clip UX).
 * Feed-style sites (Facebook, X, …) accumulate instead — like Qooly/4saved.
 */
export const PAGE_PARSER_REPLACE_HOSTS: readonly string[] = [
  'instagram.com',
  'cdninstagram.com',
  'tiktok.com',
];

/** Generic video / og:video content script should not run here. */
export const GENERIC_CONTENT_SKIP_HOSTS: readonly string[] = [
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'fb.com',
  'twitter.com',
  'x.com',
  'bilibili.com',
  'dailymotion.com',
  'vk.com',
  'vkvideo.ru',
  'ixigua.com',
  '928hd.tv',
  'showhd9.com',
  'youtube.com',
  'youtu.be',
  'googlevideo.com',
];

function hostnameOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatchesList(host: string, needles: readonly string[]): boolean {
  return needles.some((n) => host === n || host.endsWith(`.${n}`));
}

export function isIgnoredNetworkUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return NETWORK_IGNORE_HOST_REGEX.some((re) => re.test(host));
}

/** True when this page should not receive blanket progressive sniff hits. */
export function isPageParserSite(pageUrl: string): boolean {
  const host = hostnameOf(pageUrl);
  if (!host) return false;
  return hostMatchesList(host, PAGE_PARSER_HOSTS);
}

/** True when each page-media push should wipe prior page hits (IG/TikTok). */
export function isPageParserReplaceSite(pageUrl: string): boolean {
  const host = hostnameOf(pageUrl);
  if (!host) return false;
  return hostMatchesList(host, PAGE_PARSER_REPLACE_HOSTS);
}

/** Progressive MP4/webm network capture allowed for this media URL. */
export function isMp4NetworkAllowed(mediaUrl: string): boolean {
  const host = hostnameOf(mediaUrl);
  if (!host) return false;
  if (MP4_HOST_ALLOW_REGEX.some((re) => re.test(host))) return true;
  return hostMatchesList(host, MP4_HOST_ALLOWLIST);
}

export function shouldSkipGenericContentScript(): boolean {
  const host = location.hostname.toLowerCase();
  return GENERIC_CONTENT_SKIP_HOSTS.some((n) => host === n || host.endsWith(`.${n}`));
}

function pageHost(): string {
  return location.hostname.toLowerCase();
}

export function isInstagramPage(): boolean {
  const host = pageHost();
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}

export function isTikTokPage(): boolean {
  const host = pageHost();
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

export function isFacebookPage(): boolean {
  const host = pageHost();
  return (
    host === 'facebook.com' ||
    host.endsWith('.facebook.com') ||
    host === 'fb.com' ||
    host.endsWith('.fb.com')
  );
}

export function isTwitterPage(): boolean {
  const host = pageHost();
  return (
    host === 'twitter.com' ||
    host.endsWith('.twitter.com') ||
    host === 'x.com' ||
    host.endsWith('.x.com')
  );
}

/** True for X/Twitter document URL (background / network policy). */
export function isTwitterSiteUrl(pageUrl: string): boolean {
  const host = hostnameOf(pageUrl);
  if (!host) return false;
  return hostMatchesList(host, ['twitter.com', 'x.com']);
}

export function isBilibiliPage(): boolean {
  const host = pageHost();
  return host === 'bilibili.com' || host.endsWith('.bilibili.com');
}

export function isDailymotionPage(): boolean {
  const host = pageHost();
  return host === 'dailymotion.com' || host.endsWith('.dailymotion.com');
}

export function isVkPage(): boolean {
  const host = pageHost();
  return (
    host === 'vk.com' ||
    host.endsWith('.vk.com') ||
    host === 'vkvideo.ru' ||
    host.endsWith('.vkvideo.ru')
  );
}

export function isIxiguaPage(): boolean {
  const host = pageHost();
  return host === 'ixigua.com' || host.endsWith('.ixigua.com');
}

export function isNicheHlsPage(): boolean {
  const host = pageHost();
  return (
    host === '928hd.tv' ||
    host.endsWith('.928hd.tv') ||
    host === 'showhd9.com' ||
    host.endsWith('.showhd9.com')
  );
}
