/** Block YouTube and related CDN / embed hosts. */
const YOUTUBE_HOST_RE =
  /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$|(^|\.)googlevideo\.com$|(^|\.)ytimg\.com$|(^|\.)ggpht\.com$|(^|\.)googleapis\.com$|(^|\.)gvt1\.com$|(^|\.)youtubei\.googleapis\.com$/i;

export function isYouTubeRelatedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (YOUTUBE_HOST_RE.test(host)) return true;
    if (host.includes('youtube') || host.includes('googlevideo') || host.includes('ytimg')) {
      return true;
    }
    const path = `${u.pathname}${u.search}`.toLowerCase();
    if (path.includes('youtube.com') || path.includes('youtu.be')) return true;
    return false;
  } catch {
    const s = raw.toLowerCase();
    return (
      s.includes('youtube.com') ||
      s.includes('youtu.be') ||
      s.includes('googlevideo.com') ||
      s.includes('youtube-nocookie') ||
      s.includes('ytimg.com')
    );
  }
}
