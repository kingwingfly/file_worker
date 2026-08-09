/**
 * 💫 VUP Clip Gallery — Frontend
 */
'use strict';

// ── State ──
const state = {
  files: [],
  offset: 0,
  limit: 50,
  filter: 'all',
  loading: false,
  previewOpen: false,
  currentPreview: null,
};

// ── DOM Refs ──
const dom = {};

// ── Init ──
function init() {
  dom.gallery = document.getElementById('gallery');
  dom.spinner = document.getElementById('spinner');
  dom.emptyState = document.getElementById('empty-state');
  dom.errorBox = document.getElementById('error-box');
  dom.errorDetail = document.getElementById('error-detail');
  dom.retryBtn = document.getElementById('retry-btn');
  dom.loadMoreWrapper = document.getElementById('load-more-wrapper');
  dom.loadMoreBtn = document.getElementById('load-more-btn');
  dom.previewModal = document.getElementById('preview-modal');
  dom.modalMedia = document.getElementById('modal-media');
  dom.modalFilename = document.getElementById('modal-filename');
  dom.modalDownload = document.getElementById('modal-download');
  dom.filterBtns = document.querySelectorAll('.filter-btn');

  // Event listeners
  dom.filterBtns.forEach(btn => {
    btn.addEventListener('click', () => handleFilterChange(btn.dataset.filter));
  });
  dom.loadMoreBtn?.addEventListener('click', handleLoadMore);
  dom.retryBtn?.addEventListener('click', () => {
    hideError();
    fetchFiles();
  });
  dom.previewModal?.querySelector('.modal-close')?.addEventListener('click', closePreview);
  dom.previewModal?.addEventListener('click', (e) => {
    if (e.target === dom.previewModal || e.target.classList.contains('modal-backdrop')) {
      closePreview();
    }
  });
  dom.modalDownload?.addEventListener('click', () => {
    if (state.currentPreview) downloadFile(state.currentPreview);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.previewOpen) closePreview();
  });

  // Initial load
  fetchFiles();
}

// ── API ──
async function fetchFiles() {
  if (state.loading) return;
  state.loading = true;
  showSpinner();
  hideError();

  try {
    const params = new URLSearchParams({
      offset: state.offset,
      limit: state.limit,
      filter: state.filter,
    });
    const resp = await fetch(`/api/files?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    state.files = [...state.files, ...data.files];
    state.offset += data.limit;

    renderGallery();
    // A full page came back → there is probably more. A short page is the last one.
    updateLoadMore(data.files.length >= data.limit);
    updateEmptyState();
  } catch (err) {
    console.error('Failed to fetch:', err);
    showError(err.message);
  } finally {
    state.loading = false;
    hideSpinner();
  }
}

// ── Render ──
function renderGallery() {
  const filtered = getFilteredFiles();
  dom.gallery.innerHTML = '';

  if (filtered.length === 0) return;

  filtered.forEach((file, i) => {
    const card = createCard(file, i);
    dom.gallery.appendChild(card);
  });

  updateEmptyState();
}

function getFilteredFiles() {
  if (state.filter === 'all') return state.files;
  const prefix = state.filter + '/';
  return state.files.filter(f => f.content_type?.startsWith(prefix));
}

function createCard(file, index) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.style.animationDelay = `${(index % 10) * 0.05}s`;

  // Thumbnail
  const thumb = document.createElement('div');
  const ct = file.content_type || '';

  if (ct.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = `/api/file/${encodePath(file.key)}`;
    img.alt = displayName(file);
    img.loading = 'lazy';
    img.onerror = () => { img.outerHTML = placeholderHTML('🖼️'); };
    img.onclick = () => openPreview(file);
    thumb.appendChild(img);
  } else if (ct.startsWith('video/')) {
    thumb.className = 'card-thumb placeholder';
    thumb.textContent = '🎬';
    thumb.onclick = () => openPreview(file);
  } else if (ct.startsWith('audio/')) {
    thumb.className = 'card-thumb placeholder';
    thumb.textContent = '🎵';
    thumb.onclick = () => openPreview(file);
  } else {
    thumb.className = 'card-thumb placeholder';
    thumb.textContent = '✨';
    thumb.onclick = () => openPreview(file);
  }

  card.appendChild(thumb);

  // Card body — just name, size, and download
  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = displayName(file);
  name.title = displayPath(file);

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const size = document.createElement('span');
  size.className = 'card-size';
  size.textContent = formatFileSize(file.size);

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'card-download';
  downloadBtn.textContent = '⬇';
  downloadBtn.title = '下载';
  downloadBtn.onclick = (e) => { e.stopPropagation(); downloadFile(file); };

  meta.appendChild(size);
  meta.appendChild(downloadBtn);
  body.appendChild(name);
  body.appendChild(meta);
  card.appendChild(body);

  return card;
}

function placeholderHTML(emoji) {
  return `<div class="card-thumb placeholder">${emoji}</div>`;
}

// ── Preview Modal ──
function openPreview(file) {
  state.previewOpen = true;
  state.currentPreview = file;

  dom.modalFilename.textContent = displayName(file);
  dom.modalMedia.innerHTML = '';

  const ct = file.content_type || '';
  const url = `/api/file/${encodePath(file.key)}`;

  if (ct.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = displayName(file);
    dom.modalMedia.appendChild(img);
  } else if (ct.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = url;
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    vid.style.width = '100%';
    vid.style.maxHeight = '80vh';
    // Videos are served as video/mp4 whatever codec is inside, so there is no
    // way to know up front whether this browser can decode them — HEVC plays in
    // Safari everywhere and in Chrome only where the OS supplies a hardware
    // decoder. Let the element try, and catch the one error that means
    // "cannot decode at all" so the user gets a download instead of a black box.
    vid.addEventListener('error', () => {
      if (!vid.error || vid.error.code !== vid.error.MEDIA_ERR_SRC_NOT_SUPPORTED) return;
      // The event can land after the user moved on; don't overwrite whatever
      // the modal is showing now.
      if (state.currentPreview !== file) return;
      dom.modalMedia.replaceChildren(unplayableNotice(file));
    });
    dom.modalMedia.appendChild(vid);
  } else if (ct.startsWith('audio/')) {
    const wrapper = document.createElement('div');
    wrapper.style.textAlign = 'center';
    wrapper.style.padding = '3rem 2rem';
    wrapper.style.width = '100%';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';

    const visualizer = document.createElement('div');
    visualizer.className = 'audio-visualizer';
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.animationDelay = `${i * 0.05}s`;
      bar.style.animationDuration = `${0.5 + Math.random() * 0.8}s`;
      visualizer.appendChild(bar);
    }
    wrapper.appendChild(visualizer);

    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.autoplay = true;
    audio.preload = 'metadata';
    audio.style.width = '100%';
    wrapper.appendChild(audio);

    dom.modalMedia.appendChild(wrapper);
  }

  dom.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Codecs an admin might upload, with the advice that applies when *this* device
// turns out to lack a decoder for one. The HEVC and AV1 cases are near-inverses:
// Chrome and Firefox ship a software AV1 decoder so AV1 plays there on any
// platform, while HEVC needs an OS-provided hardware decoder and is Safari's
// strong suit. Sample codec strings are the standard probe values.
const VIDEO_CODECS = [
  {
    name: 'H.264',
    type: 'video/mp4; codecs="avc1.42E01E"',
    advice: '若此文件为 H.264：几乎所有浏览器都支持，播放失败通常说明文件本身有问题。',
  },
  {
    name: 'HEVC (H.265)',
    type: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    advice: '若此文件为 HEVC：请改用 Safari。Chrome 没有软件解码器，只能在 macOS、'
      + 'Android，以及装了「HEVC 视频扩展」的 Windows 上播放；Linux 版 Chrome 和 '
      + 'Firefox 无法播放。',
  },
  {
    name: 'AV1',
    type: 'video/mp4; codecs="av01.0.05M.08"',
    advice: '若此文件为 AV1：请改用 Chrome 或 Firefox，两者都内置软件解码器，任何平台都可播放。'
      + 'Safari 需要 17 及以上版本，并且要 M3 代及以后的 Apple 芯片。',
  },
  {
    name: 'VP9',
    type: 'video/mp4; codecs="vp09.00.10.08"',
    advice: '若此文件为 VP9：请改用 Chrome 或 Firefox。',
  },
];

// What this device can decode. Only ever called after a real playback failure —
// as a pre-flight gate it would be wrong, because it reports what the browser
// supports and says nothing about which codec is inside this particular file.
function probeVideoCodecs() {
  const probe = document.createElement('video');
  return VIDEO_CODECS.map(codec => ({
    ...codec,
    // '' means no; 'maybe' and 'probably' both mean it will try.
    supported: probe.canPlayType(codec.type) !== '',
  }));
}

// Replacement for a <video> the browser refused to decode. The file is served as
// video/mp4 whatever is inside it, so instead of guessing the codec we show what
// this device can decode and let the mismatch speak for itself.
function unplayableNotice(file) {
  const box = document.createElement('div');
  box.className = 'media-unplayable';

  const title = document.createElement('h3');
  title.textContent = '⚠️ 此浏览器无法播放该视频';

  const results = probeVideoCodecs();
  const unsupported = results.filter(c => !c.supported);

  const intro = document.createElement('p');
  intro.textContent = '当前设备的视频解码能力：';

  const list = document.createElement('div');
  list.className = 'codec-support';
  for (const codec of results) {
    const item = document.createElement('span');
    item.className = codec.supported ? 'ok' : 'no';
    item.textContent = `${codec.supported ? '✅' : '❌'} ${codec.name}`;
    list.appendChild(item);
  }

  const advice = document.createElement('p');
  advice.textContent = unsupported.length
    ? unsupported.map(c => c.advice).join(' ')
    // Every codec probes as playable, so the container is the likelier culprit —
    // .mkv passes the server's video/* check but no browser plays it.
    : '此设备支持上述所有编码，问题可能出在容器格式（例如 .mkv）或文件本身。'
      + '请下载后用本地播放器打开。';

  const btn = document.createElement('button');
  btn.textContent = '⬇ 下载原文件';
  btn.addEventListener('click', () => downloadFile(file));

  box.append(title, intro, list, advice, btn);
  return box;
}

function closePreview() {
  state.previewOpen = false;
  state.currentPreview = null;
  dom.previewModal.hidden = true;
  dom.modalMedia.innerHTML = '';
  document.body.style.overflow = '';
}

// ── Download ──
function downloadFile(file) {
  // The storage key is opaque, so the download name travels in the query string;
  // the worker turns it into Content-Disposition.
  const name = displayName(file);
  const url = `/api/file/${encodePath(file.key)}?download=1&name=${encodeURIComponent(name)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Filter ──
function handleFilterChange(filter) {
  if (state.filter === filter) return;

  state.filter = filter;
  state.files = [];
  state.offset = 0;

  dom.filterBtns.forEach(btn => {
    const isActive = btn.dataset.filter === filter;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive);
  });

  dom.gallery.innerHTML = '';
  updateLoadMore(false);
  fetchFiles();
}

// ── Load More ──
function handleLoadMore() {
  fetchFiles();
}

function updateLoadMore(hasMore) {
  dom.loadMoreWrapper.hidden = !hasMore;
}

// ── UI State Helpers ──
function showSpinner() { dom.spinner.hidden = false; }
function hideSpinner() { dom.spinner.hidden = true; }

function showError(msg) {
  dom.errorBox.hidden = false;
  dom.errorDetail.textContent = msg || 'Unknown error';
}

function hideError() { dom.errorBox.hidden = true; }

function updateEmptyState() {
  const filtered = getFilteredFiles();
  const show = filtered.length === 0 && !state.loading;
  dom.emptyState.hidden = !show;
}

// ── Utilities ──
function encodePath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

// A file has two names: `key` is the immutable R2 object (what URLs are built
// from) and `path` is the display name a rename moves. Older rows have no
// `path`, so fall back to `key`.
function displayPath(file) {
  return file.path || file.key;
}

function displayName(file) {
  const path = displayPath(file);
  return path.split('/').pop() || path;
}

function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

// ── Start ──
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
