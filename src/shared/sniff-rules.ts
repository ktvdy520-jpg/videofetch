/**
 * Sniff policy aligned with Qooly-style architecture:
 * - Progressive MP4/webm: allowlist only (not every CDN hit)
 * - M3U8: global, with initiator/url ignore list
 * - Site-specific pages (e.g. Instagram): content scripts, not blanket MP4 sniff
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
];

/** Generic video / og:video content script should not run here. */
export const GENERIC_CONTENT_SKIP_HOSTS: readonly string[] = [
  'instagram.com',
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

export function isInstagramPage(): boolean {
  const host = location.hostname.toLowerCase();
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}
