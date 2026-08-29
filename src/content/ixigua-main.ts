/**
 * MAIN world: read Ixigua SSR hydrate data (isolated world cannot see page JS).
 * Bridge via postMessage (CustomEvent does not cross isolated ↔ MAIN).
 */
type VideoListEntry = {
  main_url?: string;
  backup_url_1?: string;
  definition?: string;
};

type VideoResource = {
  normal?: { video_list?: Record<string, VideoListEntry> };
};

function pickFromResource(res: VideoResource | undefined): { url: string; definition?: string } | null {
  const list = res?.normal?.video_list;
  if (!list || typeof list !== 'object') return null;
  const entries = Object.values(list).filter((e) => e?.main_url || e?.backup_url_1);
  if (!entries.length) return null;
  entries.sort((a, b) => String(b.definition || '').localeCompare(String(a.definition || '')));
  const best = entries[0];
  const raw = best.main_url || best.backup_url_1;
  if (!raw) return null;
  try {
    const decoded = atob(raw);
    if (/^https?:\/\//i.test(decoded)) return { url: decoded, definition: best.definition };
  } catch {
    /* not base64 */
  }
  if (/^https?:\/\//i.test(raw)) return { url: raw, definition: best.definition };
  return null;
}

function readHydrated(): { title: string; url: string; definition?: string } | null {
  const w = window as unknown as {
    _SSR_HYDRATED_DATA?: {
      anyVideo?: {
        gidInformation?: {
          packerData?: {
            video?: {
              title?: string;
              videoResource?: VideoResource;
            };
            videoResource?: VideoResource;
          };
        };
      };
    };
  };
  const packer = w._SSR_HYDRATED_DATA?.anyVideo?.gidInformation?.packerData;
  if (!packer) return null;
  const title = packer.video?.title || document.title || 'ixigua';
  const picked =
    pickFromResource(packer.video?.videoResource) || pickFromResource(packer.videoResource);
  if (!picked) return null;
  return { title, url: picked.url, definition: picked.definition };
}

function emit(): void {
  const data = readHydrated();
  if (!data) return;
  window.postMessage({ source: 'tubebox-ixigua', type: 'IXIGUA_DATA', ...data }, '*');
}

function tryIframeFallback(): void {
  const m = location.href.match(/https:\/\/www\.ixigua\.com\/\d+/);
  if (!m || !document.body) return;
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  const cleanup = () => {
    try {
      iframe.remove();
    } catch {
      /* ignore */
    }
  };
  iframe.onload = () => {
    setTimeout(() => {
      try {
        const cw = iframe.contentWindow as Window & {
          _SSR_HYDRATED_DATA?: unknown;
        };
        if (cw?._SSR_HYDRATED_DATA) {
          (window as unknown as { _SSR_HYDRATED_DATA?: unknown })._SSR_HYDRATED_DATA =
            cw._SSR_HYDRATED_DATA;
          emit();
        }
      } catch {
        /* ignore */
      } finally {
        cleanup();
      }
    }, 200);
  };
  iframe.onerror = cleanup;
  iframe.src = m[0];
}

function rescan(): void {
  if (readHydrated()) emit();
  else tryIframeFallback();
}

emit();
setTimeout(emit, 800);
setTimeout(rescan, 1500);

window.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data;
  if (!data || data.source !== 'tubebox-ixigua') return;
  if (data.type === 'IXIGUA_RESCAN') rescan();
});
