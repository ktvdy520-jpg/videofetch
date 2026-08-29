# TubeBox

Chrome Manifest V3 extension + official GitHub Pages site.

- **Extension**: sniff MP4 / M3U8 on the current tab, inline preview, then open the official download page.
- **Website**: Qooly-style converter landing + `dl.html` (M3U8 → MP4 / MP4 fetch). Processing is **local in the browser**; click **保存** to download (no auto-download).
- No server-side ffmpeg, no recording, YouTube blocked.
- Brand green matches TomDown App (`#10B981`).

## Official site (GitHub Pages)

After enabling Pages on this repo (**Settings → Pages → Deploy from branch `main` / folder `/docs`**):

- Home: https://ktvdy520-jpg.github.io/videofetch/
- Download / convert: https://ktvdy520-jpg.github.io/videofetch/dl.html

Build the site into `docs/`:

```bash
npm.cmd run build:web
```

## Extension setup

```bash
cd E:\wwwroot\videofetch
npm.cmd install
npm.cmd run icons
npm.cmd run build
```

PowerShell may block `npm.ps1`; use `npm.cmd`.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → `dist`
4. Pin TubeBox

Default download jump target is the GitHub Pages `dl.html`. Override with `chrome.storage.sync.downloadBaseUrl` if needed.

## Dev

```bash
npm.cmd run dev          # extension
npm.cmd run dev:web      # site at http://127.0.0.1:5174/videofetch/
npm.cmd run build:all    # extension dist + docs site
```

## Behavior

1. Play media on a page → TubeBox captures streams (per current page only).
2. Popup: preview / choose quality / **下载**.
3. Opens `…/dl.html?url=…&type=m3u8|mp4` — for M3U8 the page title is **M3U8 转 MP4**.
4. Page converts locally; **保存** starts the file download.

## Notes

- GitHub Pages fetches are subject to **CORS**; public demo streams (e.g. Mux) work; some CDNs may block browser fetches.
- MPEG-TS HLS is remuxed with **mux.js**; failure falls back to `.ts`.
