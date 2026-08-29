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

export type BgMessage =
  | { type: 'GET_MEDIA_FOR_TAB'; tabId: number }
  | { type: 'REMOVE_MEDIA'; tabId: number; id: string }
  | { type: 'CLEAR_TAB'; tabId: number }
  | { type: 'OPEN_DOWNLOAD'; media: CapturedMedia };

export type BgResponse =
  | { ok: true; items: CapturedMedia[] }
  | { ok: true }
  | { ok: false; error: string };
