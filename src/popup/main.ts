import Hls from 'hls.js';
import type { CapturedMedia } from '../shared/types';
import { formatBytes, kindLabel, listBadge } from '../shared/media';
import { isYouTubeRelatedUrl } from '../shared/youtube';

const listEl = document.getElementById('list')!;
const countEl = document.getElementById('count')!;
const tipEl = document.getElementById('tip')!;

let previewId: string | null = null;
let activeHls: Hls | null = null;

async function activeTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function destroyPreviewPlayer(): void {
  if (activeHls) {
    activeHls.destroy();
    activeHls = null;
  }
}

function resolutionText(item: CapturedMedia): string {
  if (item.width && item.height) return `${item.width} × ${item.height}`;
  if (item.height) return `${item.height}p`;
  if (item.width) return `${item.width}w`;
  return listBadge(item);
}

function mountInlinePlayer(host: HTMLElement, item: CapturedMedia): void {
  destroyPreviewPlayer();
  host.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = 'preview-bar';

  const info = document.createElement('div');
  info.className = 'preview-info';
  info.innerHTML = `<span class="cam" aria-hidden="true"></span><span>${resolutionText(item)}</span>`;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-close';
  close.setAttribute('aria-label', '关闭预览');
  close.textContent = '×';
  close.addEventListener('click', () => {
    previewId = null;
    destroyPreviewPlayer();
    void load();
  });

  bar.append(info, close);

  const frame = document.createElement('div');
  frame.className = 'preview-frame';

  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'metadata';

  const err = document.createElement('div');
  err.className = 'preview-error hidden';

  frame.append(video, err);
  host.append(bar, frame);

  const showError = (msg: string) => {
    err.textContent = msg;
    err.classList.remove('hidden');
  };

  if (isYouTubeRelatedUrl(item.url)) {
    showError('不支持预览 YouTube 相关链接');
    return;
  }

  if (item.kind === 'm3u8') {
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
      });
      activeHls = hls;
      hls.loadSource(item.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(() => {
          /* autoplay may be blocked; controls remain */
        });
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          showError('预览失败：流无法加载（可能被 CORS / 防盗链限制）');
          hls.destroy();
          activeHls = null;
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = item.url;
      void video.play().catch(() => undefined);
    } else {
      showError('当前环境无法预览 M3U8');
    }
    return;
  }

  video.src = item.url;
  video.addEventListener('error', () => {
    showError('预览失败：直链无法播放（可能被防盗链限制）');
  });
  void video.play().catch(() => undefined);
}

function render(items: CapturedMedia[]): void {
  countEl.textContent = String(items.length);
  destroyPreviewPlayer();
  listEl.innerHTML = '';

  if (!items.length) {
    tipEl.textContent =
      '有些视频如果不播放可能无法被捕获。请先在页面里播放视频。不支持 YouTube。';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '没有可下载的媒体';
    listEl.appendChild(empty);
    return;
  }

  tipEl.textContent =
    '有些视频如果不播放可能无法被捕获。点左侧播放可预览，点下载将跳转到 TubeBox 官网转换页，需再点「保存」才会下载。';

  for (const item of items) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap' + (previewId === item.id ? ' is-open' : '');

    const card = document.createElement('article');
    card.className = 'item';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn-play' + (previewId === item.id ? ' active' : '');
    play.setAttribute('aria-label', '预览播放');
    play.title = '预览';
    play.innerHTML = '<span class="tri"></span>';
    play.addEventListener('click', () => {
      if (previewId === item.id) {
        previewId = null;
      } else {
        previewId = item.id;
      }
      void load();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'title';
    try {
      const base = new URL(item.url).pathname.split('/').pop() || item.title;
      name.textContent = decodeURIComponent(base);
    } catch {
      name.textContent = item.title || 'video';
    }
    name.title = item.url;

    const tags = document.createElement('div');
    tags.className = 'tags';
    const res = document.createElement('span');
    res.className = 'kind';
    res.textContent = listBadge(item);
    const fmt = document.createElement('span');
    fmt.className = 'size';
    fmt.textContent =
      item.kind === 'm3u8'
        ? 'HLS'
        : `${kindLabel(item.kind)}${item.sizeBytes ? ' · ' + formatBytes(item.sizeBytes) : ''}`;
    tags.append(res, fmt);

    meta.append(name, tags);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn-dl';
    dl.innerHTML = '<span class="dl-ico" aria-hidden="true"></span>下载';
    dl.addEventListener('click', async () => {
      destroyPreviewPlayer();
      await chrome.runtime.sendMessage({ type: 'OPEN_DOWNLOAD', media: item });
      window.close();
    });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-rm-round';
    rm.setAttribute('aria-label', '移除');
    rm.title = '移除';
    rm.textContent = '−';
    rm.addEventListener('click', async () => {
      const tabId = await activeTabId();
      if (tabId == null) return;
      if (previewId === item.id) {
        previewId = null;
        destroyPreviewPlayer();
      }
      await chrome.runtime.sendMessage({ type: 'REMOVE_MEDIA', tabId, id: item.id });
      await load();
    });

    actions.append(dl, rm);
    card.append(play, meta, actions);
    wrap.appendChild(card);

    if (previewId === item.id) {
      const preview = document.createElement('div');
      preview.className = 'preview';
      wrap.appendChild(preview);
      // Mount after in DOM
      queueMicrotask(() => mountInlinePlayer(preview, item));
    }

    listEl.appendChild(wrap);
  }
}

async function load(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId == null) {
    render([]);
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_FOR_TAB', tabId });
  if (res?.ok && Array.isArray(res.items)) {
    const items = res.items as CapturedMedia[];
    if (previewId && !items.some((i) => i.id === previewId)) {
      previewId = null;
    }
    render(items);
  } else {
    render([]);
  }
}

document.getElementById('refresh')!.addEventListener('click', () => void load());
document.getElementById('clear')!.addEventListener('click', async () => {
  const tabId = await activeTabId();
  if (tabId == null) return;
  previewId = null;
  destroyPreviewPlayer();
  await chrome.runtime.sendMessage({ type: 'CLEAR_TAB', tabId });
  await load();
});

window.addEventListener('unload', () => destroyPreviewPlayer());

void load();
// Master playlist enrichment is async — refresh list shortly after open.
setTimeout(() => {
  if (!previewId) void load();
}, 600);
setTimeout(() => {
  if (!previewId) void load();
}, 1600);
