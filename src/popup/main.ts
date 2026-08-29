import type { CapturedMedia } from '../shared/types';
import { formatBytes, kindLabel, listBadge } from '../shared/media';

const listEl = document.getElementById('list')!;
const countEl = document.getElementById('count')!;
const tipEl = document.getElementById('tip')!;

async function activeTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const t = tabs[0];
  return t?.id ?? null;
}

function render(items: CapturedMedia[]): void {
  countEl.textContent = String(items.length);
  listEl.innerHTML = '';
  if (!items.length) {
    tipEl.textContent =
      '本页暂未检测到 MP4 / M3U8。请播放或加载视频后再打开弹窗。YouTube 已被屏蔽。';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '没有可下载的媒体';
    listEl.appendChild(empty);
    return;
  }
  tipEl.textContent =
    '检测到本页媒体。HLS 会按清晰度列出（如 720p / 1080p）。点击「下载」打开本地下载页。不支持 YouTube。';

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'item';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const top = document.createElement('div');
    top.className = 'row-top';

    const res = document.createElement('span');
    res.className = 'kind';
    res.textContent = listBadge(item);

    const type = document.createElement('span');
    type.className = 'size';
    if (item.kind === 'm3u8') {
      type.textContent = kindLabel(item.kind);
    } else {
      type.textContent = `${kindLabel(item.kind)} · ${formatBytes(item.sizeBytes)}`;
    }
    top.append(res, type);

    const title = document.createElement('div');
    title.className = 'title';
    const resPrefix =
      item.height || item.width
        ? `${listBadge(item)} | `
        : item.label === 'n/a'
          ? 'n/a | '
          : '';
    title.textContent = `${resPrefix}${item.title || '未命名视频'}`;
    title.title = title.textContent;

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = item.url;
    url.title = item.url;

    meta.append(top, title, url);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn-dl';
    dl.textContent = '下载';
    dl.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'OPEN_DOWNLOAD', media: item });
      window.close();
    });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-rm';
    rm.textContent = '移除';
    rm.addEventListener('click', async () => {
      const tabId = await activeTabId();
      if (tabId == null) return;
      await chrome.runtime.sendMessage({ type: 'REMOVE_MEDIA', tabId, id: item.id });
      await load();
    });

    actions.append(dl, rm);
    card.append(meta, actions);
    listEl.appendChild(card);
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
    render(res.items as CapturedMedia[]);
  } else {
    render([]);
  }
}

document.getElementById('refresh')!.addEventListener('click', () => void load());
document.getElementById('clear')!.addEventListener('click', async () => {
  const tabId = await activeTabId();
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_TAB', tabId });
  await load();
});

void load();
// Master playlist enrichment is async — refresh list shortly after open.
setTimeout(() => void load(), 600);
setTimeout(() => void load(), 1600);
