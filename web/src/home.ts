const form = document.getElementById('goForm') as HTMLFormElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const typeInput = document.getElementById('typeInput') as HTMLSelectElement;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  const type = typeInput.value === 'mp4' ? 'mp4' : 'm3u8';
  const q = new URLSearchParams({
    url,
    type,
    title: type === 'm3u8' ? 'video' : 'video',
  });
  location.href = `./dl.html?${q.toString()}`;
});
