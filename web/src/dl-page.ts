import { formatBytes, guessFilename } from '@shared/media';
import { transmuxTsSegmentsToMp4 } from '@shared/ts-to-mp4';
import { isYouTubeRelatedUrl } from '@shared/youtube';
import type { MediaKind } from '@shared/types';

const pageTitleEl = document.getElementById('pageTitle')!;
const pageSubEl = document.getElementById('pageSub')!;
const titleEl = document.getElementById('title')!;
const metaEl = document.getElementById('meta')!;
const sourceEl = document.getElementById('source')!;
const fillEl = document.getElementById('fill')!;
const progressText = document.getElementById('progressText')!;
const statsEl = document.getElementById('stats')!;
const noteEl = document.getElementById('note')!;
const logEl = document.getElementById('log')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;

interface PageQuery {
  url: string;
  title: string;
  type: MediaKind;
  source: string;
}

function parseQuery(search: string): PageQuery | null {
  const q = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const url = q.get('url') || q.get('query');
  if (!url) return null;
  const typeRaw = (q.get('type') || '').toLowerCase();
  let type: MediaKind = 'mp4';
  if (typeRaw === 'm3u8' || /\.m3u8(\?|$)/i.test(url)) type = 'm3u8';
  else if (typeRaw === 'other') type = 'other';
  return {
    url,
    title: q.get('title') || 'video',
    type,
    source: q.get('source') || '',
  };
}

const query = parseQuery(location.search);
let aborted = false;
let objectUrl: string | null = null;
let readyBlob: Blob | null = null;
let readyName = 'video.mp4';

const FETCH_TIMEOUT_MS = 45_000;
const SEGMENT_CONCURRENCY = 8;

function log(msg: string): void {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(pct: number, text: string): void {
  const p = Math.max(0, Math.min(100, pct));
  fillEl.style.width = `${p}%`;
  progressText.textContent = text;
}

function cleanupObjectUrl(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function prepareSave(blob: Blob, filename: string): void {
  readyBlob = blob;
  readyName = filename;
  cleanupObjectUrl();
  objectUrl = URL.createObjectURL(blob);
  saveBtn.disabled = false;
  saveBtn.textContent = `保存 ${filename}`;
  noteEl.textContent = '转换已完成。请点击「保存」下载到本机（不会自动下载）。';
}

function throwIfAborted(): void {
  if (aborted) throw new Error('已取消');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  throwIfAborted();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const watch = setInterval(() => {
    if (aborted) ctrl.abort();
  }, 200);
  try {
    return await fetch(url, { credentials: 'omit', mode: 'cors', signal: ctrl.signal });
  } catch (e) {
    if (aborted) throw new Error('已取消');
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000}s）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} 读取播放列表失败`);
  return res.text();
}

async function fetchBinary(url: string): Promise<Uint8Array> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url.slice(0, 120)}`);
  return new Uint8Array(await res.arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

async function fetchBinariesParallel(
  urls: string[],
  concurrency: number,
  onProgress: (done: number, total: number, inFlight: number) => void,
): Promise<Uint8Array[]> {
  const total = urls.length;
  const results: Uint8Array[] = new Array(total);
  let next = 0;
  let done = 0;
  let inFlight = 0;

  async function worker(): Promise<void> {
    for (;;) {
      throwIfAborted();
      const i = next++;
      if (i >= total) return;
      inFlight++;
      onProgress(done, total, inFlight);
      try {
        results[i] = await fetchBinary(urls[i]);
      } finally {
        inFlight--;
        done++;
        onProgress(done, total, inFlight);
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

interface ParsedPlaylist {
  isMaster: boolean;
  variants: { bandwidth: number; resolution?: string; uri: string }[];
  segments: { uri: string; duration: number }[];
  initUri?: string;
  isFmp4: boolean;
}

function parseM3u8(text: string, playlistUrl: string): ParsedPlaylist {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const variants: ParsedPlaylist['variants'] = [];
  const segments: ParsedPlaylist['segments'] = [];
  let isMaster = false;
  let isFmp4 = false;
  let initUri: string | undefined;
  let pendingBandwidth = 0;
  let pendingRes: string | undefined;
  let pendingDuration = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const res = /RESOLUTION=([\dx]+)/i.exec(line);
      pendingBandwidth = bw ? Number(bw[1]) : 0;
      pendingRes = res?.[1];
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      isFmp4 = true;
      const uri = /URI="([^"]+)"/i.exec(line);
      if (uri) initUri = resolveUrl(playlistUrl, uri[1]);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const d = /#EXTINF:([\d.]+)/i.exec(line);
      pendingDuration = d ? Number(d[1]) : 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    const uri = resolveUrl(playlistUrl, line);
    if (isMaster || /\.m3u8(\?|$)/i.test(line)) {
      isMaster = true;
      variants.push({ bandwidth: pendingBandwidth, resolution: pendingRes, uri });
      pendingBandwidth = 0;
      pendingRes = undefined;
    } else {
      segments.push({ uri, duration: pendingDuration });
      if (/\.m4s(\?|$)/i.test(uri) || /\.mp4(\?|$)/i.test(uri)) isFmp4 = true;
      pendingDuration = 0;
    }
  }

  if (variants.length > 0) {
    return { isMaster: true, variants, segments: [], initUri, isFmp4 };
  }
  return { isMaster: false, variants: [], segments, initUri, isFmp4 };
}

function looksLikeTs(bytes: Uint8Array): boolean {
  if (bytes.length < 188) return false;
  if (bytes[0] === 0x47 && bytes[188] === 0x47) return true;
  for (let i = 0; i < Math.min(bytes.length - 188, 2048); i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) return true;
  }
  return false;
}

async function downloadMp4(url: string, filename: string): Promise<void> {
  noteEl.textContent = '正在拉取 MP4（浏览器本地）。完成后请点击「保存」。';
  const data = await fetchBinary(url);
  setProgress(100, '拉取完成，等待保存');
  prepareSave(new Blob([toArrayBuffer(data)], { type: 'video/mp4' }), filename);
  log(`MP4 就绪 ${formatBytes(data.byteLength)}`);
}

async function downloadM3u8(playlistUrl: string, title: string): Promise<void> {
  noteEl.textContent =
    'M3U8：本地下载分片并用 mux.js 转封装为 MP4。完成后请点击「保存」，不会自动下载。';

  setProgress(2, '读取播放列表…');
  let text = await fetchText(playlistUrl);
  let parsed = parseM3u8(text, playlistUrl);
  let mediaUrl = playlistUrl;

  if (parsed.isMaster && parsed.variants.length) {
    const best = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    log(`主播放列表：选中 ${best.bandwidth}${best.resolution ? ` @ ${best.resolution}` : ''}`);
    mediaUrl = best.uri;
    text = await fetchText(mediaUrl);
    parsed = parseM3u8(text, mediaUrl);
  }

  if (!parsed.segments.length) throw new Error('播放列表中没有分片');

  statsEl.textContent = `分片数量：${parsed.segments.length}${parsed.isFmp4 ? ' (fMP4)' : ''} · 并发 ${SEGMENT_CONCURRENCY}`;
  log(statsEl.textContent);

  const initParts: Uint8Array[] = [];
  if (parsed.initUri) {
    initParts.push(await fetchBinary(parsed.initUri));
  }

  const segmentBytes = await fetchBinariesParallel(
    parsed.segments.map((s) => s.uri),
    SEGMENT_CONCURRENCY,
    (done, total, inFlight) => {
      const pct = 5 + (done / total) * 85;
      setProgress(
        pct,
        `分片 ${done} / ${total}（${((done / total) * 100).toFixed(1)}%）` +
          (inFlight > 0 ? ` · 并行 ${inFlight}` : ''),
      );
    },
  );

  throwIfAborted();
  const baseName = guessFilename(title, 'm3u8', playlistUrl).replace(/\.(ts|mp4)$/i, '');

  if (parsed.isFmp4) {
    const merged = concat([...initParts, ...segmentBytes]);
    prepareSave(new Blob([toArrayBuffer(merged)], { type: 'video/mp4' }), `${baseName}.mp4`);
    setProgress(100, '转换完成，请点击保存');
    return;
  }

  const probe = segmentBytes.find((s) => s.byteLength > 188) || concat(segmentBytes);
  if (looksLikeTs(probe)) {
    setProgress(92, 'mux.js 转封装 MP4…');
    try {
      const mp4 = transmuxTsSegmentsToMp4(segmentBytes);
      prepareSave(new Blob([toArrayBuffer(mp4)], { type: 'video/mp4' }), `${baseName}.mp4`);
      setProgress(100, '转换完成，请点击保存');
      log(`MP4 就绪 ${formatBytes(mp4.byteLength)}`);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`mux.js 失败，回退 .ts：${msg}`);
      const merged = concat(segmentBytes);
      prepareSave(new Blob([toArrayBuffer(merged)], { type: 'video/mp2t' }), `${baseName}.ts`);
      setProgress(100, '已就绪（.ts），请点击保存');
      return;
    }
  }

  const merged = concat([...initParts, ...segmentBytes]);
  prepareSave(new Blob([toArrayBuffer(merged)]), `${baseName}.bin`);
  setProgress(100, '已就绪，请点击保存');
}

function applyPageChrome(): void {
  if (!query) return;
  if (query.type === 'm3u8') {
    document.title = 'M3U8 转 MP4 - TubeBox';
    pageTitleEl.textContent = 'M3U8 转 MP4';
    pageSubEl.textContent = '请稍候，M3U8 转 MP4 转换完成后，点击「保存」按钮保存文件。';
  } else {
    document.title = 'MP4 视频下载 - TubeBox';
    pageTitleEl.textContent = 'MP4 视频下载';
    pageSubEl.textContent = '拉取完成后，点击「保存」下载文件（不会自动下载）。';
  }
}

async function run(): Promise<void> {
  if (!query) {
    titleEl.textContent = '缺少下载参数';
    setProgress(0, '请从扩展跳转，或在首页粘贴链接');
    startBtn.disabled = true;
    return;
  }

  if (isYouTubeRelatedUrl(query.url) || (query.source && isYouTubeRelatedUrl(query.source))) {
    titleEl.textContent = '已拦截 YouTube';
    startBtn.disabled = true;
    setProgress(0, '已阻止');
    return;
  }

  applyPageChrome();
  titleEl.textContent = query.title || '未命名视频';
  metaEl.textContent = query.type === 'm3u8' ? 'M3U8 / HLS' : 'MP4';
  sourceEl.textContent = query.url;

  aborted = false;
  readyBlob = null;
  saveBtn.disabled = true;
  saveBtn.textContent = '保存';
  startBtn.disabled = true;
  cancelBtn.disabled = false;
  logEl.textContent = '';
  cleanupObjectUrl();

  try {
    if (query.type === 'm3u8') {
      await downloadM3u8(query.url, query.title);
    } else {
      const name = guessFilename(query.title, 'mp4', query.url);
      await downloadMp4(query.url, name.endsWith('.mp4') ? name : `${name}.mp4`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setProgress(0, `失败：${msg}`);
    log(`错误: ${msg}`);
    noteEl.textContent =
      '失败常见原因：目标站 CORS / 防盗链。公开测试流通常可用；部分站点需扩展侧代拉（后续可加）。';
  } finally {
    startBtn.disabled = false;
    cancelBtn.disabled = true;
  }
}

startBtn.addEventListener('click', () => void run());
cancelBtn.addEventListener('click', () => {
  aborted = true;
  cancelBtn.disabled = true;
  progressText.textContent = '正在取消…';
});
saveBtn.addEventListener('click', () => {
  if (!readyBlob || !objectUrl) return;
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = readyName;
  a.click();
});

applyPageChrome();
if (query) {
  titleEl.textContent = query.title || '未命名视频';
  metaEl.textContent = query.type === 'm3u8' ? 'M3U8 / HLS' : 'MP4';
  sourceEl.textContent = query.url;
  void run();
} else {
  titleEl.textContent = '请提供链接';
  startBtn.disabled = true;
  setProgress(0, '无参数');
}
