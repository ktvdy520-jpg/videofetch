import { parseDlQuery } from '../shared/dl-url';
import { formatBytes, guessFilename } from '../shared/media';
import { isYouTubeRelatedUrl } from '../shared/youtube';
import { transmuxTsSegmentsToMp4 } from '../shared/ts-to-mp4';

const titleEl = document.getElementById('title')!;
const metaEl = document.getElementById('meta')!;
const sourceEl = document.getElementById('source')!;
const fillEl = document.getElementById('fill')!;
const progressText = document.getElementById('progressText')!;
const noteEl = document.getElementById('note')!;
const logEl = document.getElementById('log')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
const saveLink = document.getElementById('saveLink') as HTMLAnchorElement;

const query = parseDlQuery(location.search);
let aborted = false;
let objectUrl: string | null = null;

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

function offerDownload(blob: Blob, filename: string): void {
  cleanupObjectUrl();
  objectUrl = URL.createObjectURL(blob);
  saveLink.href = objectUrl;
  saveLink.download = filename;
  saveLink.classList.remove('hidden');
  saveLink.textContent = `保存 ${filename}`;
  // Do not auto-click — user must click Save (same as official web page).
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      variants.push({
        bandwidth: pendingBandwidth,
        resolution: pendingRes,
        uri,
      });
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

const FETCH_TIMEOUT_MS = 45_000;
const SEGMENT_CONCURRENCY = 8;

function throwIfAborted(): void {
  if (aborted) throw new Error('已取消');
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  throwIfAborted();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbortWatch = () => {
    if (aborted) ctrl.abort();
  };
  const watch = setInterval(onAbortWatch, 200);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      mode: 'cors',
      ...init,
      signal: ctrl.signal,
    });
    return res;
  } catch (e) {
    if (aborted) throw new Error('已取消');
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000}s）: ${url.slice(0, 100)}`);
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

async function fetchBinary(
  url: string,
  onChunk?: (received: number, total?: number) => void,
): Promise<Uint8Array> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url.slice(0, 120)}`);
  const total = Number(res.headers.get('content-length') || 0) || undefined;
  if (!res.body || !onChunk) {
    const buf = new Uint8Array(await res.arrayBuffer());
    throwIfAborted();
    onChunk?.(buf.byteLength, total ?? buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onChunk(received, total);
    }
  }
  return concat(chunks);
}

/** Download many URLs with limited concurrency; results keep input order. */
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

function looksLikeTs(bytes: Uint8Array): boolean {
  if (bytes.length < 188) return false;
  if (bytes[0] === 0x47 && bytes[188] === 0x47) return true;
  for (let i = 0; i < Math.min(bytes.length - 188, 2048); i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) return true;
  }
  return false;
}

async function downloadMp4(url: string, filename: string): Promise<void> {
  noteEl.textContent = '正在直接拉取 MP4（浏览器端，不经服务器转码）。';
  const data = await fetchBinary(url, (received, total) => {
    if (total) {
      const pct = (received / total) * 100;
      setProgress(pct, `下载中 ${formatBytes(received)} / ${formatBytes(total)} (${pct.toFixed(1)}%)`);
    } else {
      setProgress(Math.min(95, received / 1_000_000), `已下载 ${formatBytes(received)}`);
    }
  });
  setProgress(100, '完成，正在生成文件…');
  const blob = new Blob([toArrayBuffer(data)], { type: 'video/mp4' });
  offerDownload(blob, filename.endsWith('.mp4') ? filename : `${filename}.mp4`);
  log(`MP4 完成，大小 ${formatBytes(data.byteLength)}`);
}

async function pickMediaPlaylist(masterUrl: string, parsed: ParsedPlaylist): Promise<string> {
  if (!parsed.isMaster || parsed.variants.length === 0) return masterUrl;
  const sorted = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth);
  const best = sorted[0];
  log(
    `主播放列表：选中码率 ${best.bandwidth}${best.resolution ? ` @ ${best.resolution}` : ''}`,
  );
  return best.uri;
}

async function downloadM3u8(playlistUrl: string, title: string): Promise<void> {
  noteEl.textContent =
    'M3U8：本地下载分片。MPEG-TS 将用 mux.js 转封装为 MP4；fMP4 直接拼接。不上传服务器、无服务端 ffmpeg。';

  setProgress(2, '读取播放列表…');
  let text = await fetchText(playlistUrl);
  let parsed = parseM3u8(text, playlistUrl);
  let mediaUrl = playlistUrl;

  if (parsed.isMaster) {
    mediaUrl = await pickMediaPlaylist(playlistUrl, parsed);
    if (aborted) throw new Error('已取消');
    text = await fetchText(mediaUrl);
    parsed = parseM3u8(text, mediaUrl);
  }

  if (parsed.segments.length === 0) {
    throw new Error('播放列表中没有分片');
  }

  log(
    `分片数量: ${parsed.segments.length}${parsed.isFmp4 ? ' (fMP4)' : ' (可能为 TS)'} · 并发 ${SEGMENT_CONCURRENCY}`,
  );

  const initParts: Uint8Array[] = [];
  if (parsed.initUri) {
    log('下载初始化段 INIT');
    setProgress(3, '下载初始化段…');
    initParts.push(await fetchBinary(parsed.initUri));
  }

  const total = parsed.segments.length;
  setProgress(5, `并发下载分片 0 / ${total}…`);
  const segmentBytes = await fetchBinariesParallel(
    parsed.segments.map((s) => s.uri),
    SEGMENT_CONCURRENCY,
    (done, segTotal, inFlight) => {
      const pct = 5 + (done / segTotal) * 85;
      setProgress(
        pct,
        `分片 ${done} / ${segTotal}（${((done / segTotal) * 100).toFixed(1)}%）` +
          (inFlight > 0 ? ` · 并行 ${inFlight}` : ''),
      );
    },
  );

  throwIfAborted();
  const baseName = guessFilename(title, 'm3u8', playlistUrl).replace(/\.(ts|mp4)$/i, '');

  if (parsed.isFmp4) {
    const merged = concat([...initParts, ...segmentBytes]);
    setProgress(98, '拼接 fMP4…');
    const blob = new Blob([toArrayBuffer(merged)], { type: 'video/mp4' });
    offerDownload(blob, `${baseName}.mp4`);
    log(`已保存 fMP4：${baseName}.mp4（${formatBytes(merged.byteLength)}）`);
    return;
  }

  const probe = segmentBytes.find((s) => s.byteLength > 188) || concat(segmentBytes);
  if (looksLikeTs(probe)) {
    setProgress(92, 'mux.js 转封装 MP4…');
    log('检测到 MPEG-TS，使用 mux.js 本地转封装为 MP4…');
    try {
      const mp4 = transmuxTsSegmentsToMp4(segmentBytes);
      setProgress(100, '转封装完成，准备保存…');
      const blob = new Blob([toArrayBuffer(mp4)], { type: 'video/mp4' });
      offerDownload(blob, `${baseName}.mp4`);
      log(`已保存 MP4（mux.js）：${baseName}.mp4（${formatBytes(mp4.byteLength)}）`);
      noteEl.textContent =
        '已用 mux.js 将 MPEG-TS 转封装为 MP4（浏览器本地，非服务器转码）。若个别播放器无法打开，可再试其它播放器。';
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`mux.js 转封装失败，回退保存 .ts：${msg}`);
      const merged = concat(segmentBytes);
      const tsBlob = new Blob([toArrayBuffer(merged)], { type: 'video/mp2t' });
      offerDownload(tsBlob, `${baseName}.ts`);
      noteEl.textContent =
        'mux.js 转 MP4 失败，已回退保存 MPEG-TS（.ts）。可用支持 TS 的播放器打开，或本机 ffmpeg 转封装。';
      return;
    }
  }

  const merged = concat([...initParts, ...segmentBytes]);
  setProgress(100, '准备保存…');
  const blob = new Blob([toArrayBuffer(merged)], { type: 'application/octet-stream' });
  offerDownload(blob, `${baseName}.bin`);
  log(`未能识别封装，已保存为 ${baseName}.bin`);
}

async function run(): Promise<void> {
  if (!query) {
    titleEl.textContent = '缺少下载参数';
    setProgress(0, 'URL 无效');
    startBtn.disabled = true;
    return;
  }

  if (isYouTubeRelatedUrl(query.url) || (query.source && isYouTubeRelatedUrl(query.source))) {
    titleEl.textContent = '已拦截 YouTube';
    metaEl.textContent = '本扩展不支持 YouTube / googlevideo 等链接。';
    startBtn.disabled = true;
    setProgress(0, '已阻止');
    return;
  }

  titleEl.textContent = query.title || '未命名视频';
  metaEl.textContent = `${query.type === 'm3u8' ? 'M3U8 / HLS' : 'MP4'} · ${
    query.size ? formatBytes(query.size) : '大小未知'
  }`;
  sourceEl.textContent = query.url;

  aborted = false;
  startBtn.disabled = true;
  cancelBtn.disabled = false;
  saveLink.classList.add('hidden');
  logEl.textContent = '';
  cleanupObjectUrl();

  try {
    if (query.type === 'm3u8') {
      await downloadM3u8(query.url, query.title);
    } else {
      const name = guessFilename(query.title, 'mp4', query.url);
      await downloadMp4(query.url, name);
    }
    setProgress(100, '下载完成');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setProgress(0, `失败：${msg}`);
    log(`错误: ${msg}`);
    noteEl.textContent =
      '若失败多为目标站 CORS 限制。扩展页请求可避开网页 CORS，但仍受对方响应头约束；本页使用 credentials:omit。';
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

if (query) {
  titleEl.textContent = query.title || '未命名视频';
  metaEl.textContent = `${query.type === 'm3u8' ? 'M3U8 / HLS' : 'MP4'} · 就绪`;
  sourceEl.textContent = query.url;
  void run();
} else {
  titleEl.textContent = '缺少参数';
  startBtn.disabled = true;
}
