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
}

export interface PageMediaLink {
  url: string;
  title?: string;
  kind?: MediaKind;
  width?: number;
  height?: number;
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
  | { type: 'GET_IG_APP_ID' };

/** Background → content scripts */
export type ContentMessage = { type: 'RESET_PAGE_SCAN' };

export type BgResponse =
  | { ok: true; items: CapturedMedia[] }
  | { ok: true; appId?: string }
  | { ok: true }
  | { ok: false; error: string };
