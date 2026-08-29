# TubeBox

Chrome Manifest V3 extension that sniffs MP4 / M3U8 on the current tab and opens an **in-extension** download page (`chrome-extension://…/src/dl/index.html`). No server-side ffmpeg, no upload for transcoding, and **no recording**. YouTube and related hosts are blocked.

Brand green matches TomDown App (`#10B981`).

## Stack

- Vite + `@crxjs/vite-plugin`
- TypeScript
- MV3 service worker (`webRequest` sniffing)

## Setup

```bash
cd E:\wwwroot\videofetch
npm.cmd install
npm.cmd run icons
npm.cmd run build
```

PowerShell may block `npm.ps1`; use `npm.cmd` as above.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist` folder produced by the build
4. Pin TubeBox

## Dev

```bash
npm.cmd run dev
```

Load the unpacked path Vite/CRX prints (often `dist` with HMR). Keep reloading the extension after major changes.

## How to test

### MP4

1. Open a page that plays a direct MP4, e.g.  
   `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4`  
   (or embed it in a simple HTML page and play)
2. Open the popup → you should see an **MP4** row with size when Content-Length is present
3. Click **下载** → download page shows a progress bar and saves a `.mp4`

### M3U8 (HLS)

1. Open a public HLS demo, e.g. Mux test stream page or playlist such as  
   `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`  
   (open in a player page so the browser requests the playlist, or navigate so sniffing sees `.m3u8`)
2. Popup lists **M3U8** → **下载**
3. Download page parses master/media playlist, fetches segments with progress `x / y`, concatenates:
   - **MPEG-TS** segments → save as `.ts` (honest: not ffmpeg remux; continuous TS is widely playable)
   - **fMP4** (`.m4s` + init) → save as `.mp4`

### YouTube

Any `youtube.com` / `youtu.be` / `googlevideo.com` / `ytimg` / etc. media or page is ignored / blocked.

## Optional custom download host

In the extension’s service worker console or via `chrome.storage.sync.set`:

```js
chrome.storage.sync.set({ downloadBaseUrl: 'https://example.com/dl/' })
```

Default remains the packaged `src/dl/index.html` (local-first, better for CORS than a random https origin).

## Scripts

| Command | Description |
|--------|-------------|
| `npm.cmd run icons` | Generate `public/icons/icon{16,48,128}.png` |
| `npm.cmd run build` | Typecheck + production build → `dist` |
| `npm.cmd run dev` | CRX/Vite development build |

## Notes / limitations

- Sniffing uses `webRequest.onHeadersReceived`; media must be requested by the tab.
- Download uses `fetch` with `credentials: "omit"` from the extension page. Sites that require cookies or block cross-origin may still fail.
- Concatenated TS saved as `.mp4` without remux is **not** a real MP4 container; TubeBox uses mux.js to remux TS → MP4 when possible, otherwise falls back to `.ts`.
- No record / screen-capture feature by design.
