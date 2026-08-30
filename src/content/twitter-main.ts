/**
 * MAIN world: intercept X/Twitter XHR+fetch for video_info (Qooly/4saved).
 * Keep every non-HLS variant (unlabeled → n/a); never application/x-mpegURL.
 */
type Variant = { content_type?: string; url?: string; bitrate?: number };

type OutLink = {
  url: string;
  title: string;
  width?: number;
  height?: number;
  bitrate: number;
};

const SOURCE = 'tubebox-x';

function deepVideoInfos(obj: unknown, out: Array<{ variants?: Variant[] }> = []): typeof out {
  if (obj == null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) deepVideoInfos(item, out);
    return out;
  }
  const rec = obj as Record<string, unknown>;
  if (rec.video_info && typeof rec.video_info === 'object') {
    out.push(rec.video_info as { variants?: Variant[] });
  }
  for (const v of Object.values(rec)) deepVideoInfos(v, out);
  return out;
}

function allNonHlsVariants(variants: Variant[] | undefined, title: string): OutLink[] {
  if (!variants?.length) return [];
  return variants
    .filter((v) => {
      if (!v.url || !/^https?:\/\//i.test(v.url)) return false;
      // Qooly/4saved: ONLY exact content_type match — do not also filter by .m3u8 URL.
      return v.content_type !== 'application/x-mpegURL';
    })
    .map((v) => {
      // Quality label: only avc1/WxH (competitor); otherwise n/a.
      const m = v.url!.match(/avc1\/(\d{3,4})x(\d{3,4})/);
      const width = m ? Number(m[1]) : undefined;
      const height = m ? Number(m[2]) : undefined;
      return {
        url: v.url!,
        title,
        width,
        height,
        bitrate: v.bitrate || 0,
      };
    })
    .sort((a, b) => (b.width || 0) - (a.width || 0) || b.bitrate - a.bitrate);
}

function emitFromText(text: string): void {
  if (!text || !text.includes('video_info')) return;
  const title = (document.title || 'twitter video').slice(0, 80);
  const links: OutLink[] = [];
  const seen = new Set<string>();

  const chunks = text.includes('\n') ? text.split('\n').filter((l) => l.trim()) : [text];
  for (const chunk of chunks) {
    let data: unknown;
    try {
      data = JSON.parse(chunk);
    } catch {
      continue;
    }
    for (const info of deepVideoInfos(data)) {
      for (const link of allNonHlsVariants(info.variants, title)) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        links.push(link);
      }
    }
  }

  if (!links.length) return;
  window.postMessage({ source: SOURCE, type: 'VIDEO_MP4', links }, '*');
}

function hookFetch(): void {
  const orig = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await orig(...args);
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json') || ct.includes('javascript') || ct.includes('text')) {
        void res
          .clone()
          .text()
          .then(emitFromText)
          .catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return res;
  };
}

function hookXhr(): void {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    (this as XMLHttpRequest & { __tbUrl?: string }).__tbUrl = String(url);
    return open.apply(this, [method, url, ...rest] as Parameters<typeof open>);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener('load', function (this: XMLHttpRequest) {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (
          typeof this.responseText === 'string' &&
          (ct.includes('json') || ct.includes('javascript') || ct.includes('text') || !ct)
        ) {
          emitFromText(this.responseText);
        }
      } catch {
        /* ignore */
      }
    });
    return send.call(this, body);
  };
}

hookFetch();
hookXhr();
