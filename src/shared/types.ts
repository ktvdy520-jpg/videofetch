export type MediaKind = 'mp4' | 'm3u8' | 'other';

export interface CapturedMedia {
  id: string;
  url: string;
  tabId: number;
  pageUrl: string;
  title: string;
  kind: MediaKind;
  mime?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  label?: string;
  capturedAt: number;
  /** How the item was discovered. */
  source?: 'network' | 'page';
  /** Lower sorts first (page parsers: 0 = primary / address-bar). */
  priority?: number;
}

export interface PageMediaLink {
  url: string;
  title?: string;
  kind?: MediaKind;
  width?: number;
  height?: number;
  /** Lower sorts first in the popup (0 = address-bar / primary clip). */
  priority?: number;
  label?: string;
}

export interface DlQuery {
  url: string;
  title: string;
  type: MediaKind;
  source: string;
  size?: number;
  width?: number;
  height?: number;
}

/** Popup / background → background */
export type BgMessage =
  | { type: 'GET_MEDIA_FOR_TAB'; tabId: number }
  | { type: 'REMOVE_MEDIA'; tabId: number; id: string }
  | { type: 'CLEAR_TAB'; tabId: number }
  | { type: 'OPEN_DOWNLOAD'; media: CapturedMedia }
  | { type: 'ADD_PAGE_MEDIA'; links: PageMediaLink[] }
  /** Clear tab + ask content scripts to rescan current page. */
  | { type: 'RESYNC_TAB'; tabId: number }
  /** Content noticed SPA navigation (href changed). */
  | { type: 'PAGE_NAVIGATED' }
  /** Instagram content script asks for captured x-ig-app-id. */
  | { type: 'GET_IG_APP_ID' }
  /** Facebook content script asks for captured fb_dtsg_ag. */
  | { type: 'GET_FB_DTSG' }
  /** Twitter/X: resolve tweet video variants via background API. */
  | { type: 'GET_TWITTER_VIDEO'; tweetId: string; csrfToken?: string };

/** Background → content scripts */
export type ContentMessage = { type: 'RESET_PAGE_SCAN' };

/** Background → open popup (and any other extension pages). */
export type ExtEvent = { type: 'MEDIA_LIST_CHANGED'; tabId: number };

export type BgResponse =
  | { ok: true; items: CapturedMedia[] }
  | { ok: true; appId?: string }
  | { ok: true; dtsg?: string }
  | { ok: true; links: PageMediaLink[] }
  | { ok: true }
  | { ok: false; error: string };
