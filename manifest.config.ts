import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'TubeBox',
  description:
    'TubeBox detects MP4 / M3U8 on web pages and downloads locally. YouTube is not supported.',
  version: '0.1.0',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'TubeBox',
    default_icon: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['storage', 'tabs', 'webRequest'],
  host_permissions: ['http://*/*', 'https://*/*'],
  content_scripts: [
    {
      matches: ['*://*.instagram.com/*', '*://instagram.com/*'],
      js: ['src/content/instagram-main.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    {
      matches: ['*://*.instagram.com/*', '*://instagram.com/*'],
      js: ['src/content/instagram.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['http://*/*', 'https://*/*'],
      exclude_matches: [
        '*://*.instagram.com/*',
        '*://instagram.com/*',
        '*://*.youtube.com/*',
        '*://youtube.com/*',
        '*://youtu.be/*',
      ],
      js: ['src/content/generic.ts'],
      run_at: 'document_idle',
    },
  ],
  icons: {
    '16': 'icons/icon16.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
  web_accessible_resources: [
    {
      resources: ['src/dl/index.html', 'assets/*'],
      matches: ['http://*/*', 'https://*/*'],
    },
  ],
});
