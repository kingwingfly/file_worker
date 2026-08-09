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
  dom.modalClipBtn = document.getElementById('modal-clip-btn');
  dom.clipPanel = document.getElementById('clip-panel');
  dom.clipPanelList = document.getElementById('clip-panel-list');
  dom.clipPanelClose = document.getElementById('clip-panel-close');
  dom.clipPageLink = document.getElementById('clip-page-link');

  dom.modalClipBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleClipPanel();
  });
  dom.clipPanelClose?.addEventListener('click', () => {
    dom.clipPanel.hidden = true;
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

  // Show clip button for video/audio, hide for images
  if (dom.modalClipBtn) {
    dom.modalClipBtn.hidden = !(ct.startsWith('video/') || ct.startsWith('audio/'));
  }
  if (dom.clipPanel) dom.clipPanel.hidden = true;

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

// ── Clip panel ──
let clipIdentity = null;

async function ensureClipIdentity() {
  if (clipIdentity) return clipIdentity;
  try {
    const resp = await fetch('/api/identity/me');
    if (resp.ok) {
      const data = await resp.json();
      if (data.identity) { clipIdentity = data.identity; return clipIdentity; }
    }
    // No identity — get a silent one
    const idResp = await fetch('/api/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '' }),
    });
    if (idResp.ok) {
      const data = await idResp.json();
      clipIdentity = { id: data.id, nickname: '' };
      return clipIdentity;
    }
  } catch (_) {}
  return null;
}

function toggleClipPanel() {
  const show = dom.clipPanel.hidden;
  dom.clipPanel.hidden = !show;
  if (show && state.currentPreview) {
    loadClipPanel(state.currentPreview);
  }
}

async function loadClipPanel(file) {
  dom.clipPanelList.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-light);">加载中...</div>';
  dom.clipPageLink.href = '/clip?file=' + encodeURIComponent(displayPath(file)) +
    '&key=' + encodeURIComponent(file.key) +
    '&type=' + ((file.content_type || '').startsWith('audio/') ? 'audio' : 'video');

  try {
    const resp = await fetch('/api/clips?file_path=' + encodeURIComponent(displayPath(file)) + '&sort=likes&limit=50');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    renderClipPanel(data.clips || []);
  } catch (err) {
    dom.clipPanelList.innerHTML = '<div style="text-align:center;padding:1rem;color:#C0392B;">加载失败: ' + err.message + '</div>';
  }
}

function renderClipPanel(clips) {
  if (!clips.length) {
    dom.clipPanelList.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-light);">暂无切片。去<a href="' + dom.clipPageLink.href + '" style="color:var(--pink);">切片页面</a>创建第一个！</div>';
    return;
  }
  dom.clipPanelList.replaceChildren(...clips.map(c => {
    const card = document.createElement('div');
    card.style.cssText = 'padding:0.5rem 0.6rem;border-bottom:1px solid #f0f0f0;font-size:0.85rem;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:0.4rem;margin-bottom:0.2rem;';

    const name = document.createElement('span');
    name.style.cssText = 'font-weight:600;cursor:pointer;color:var(--pink);';
    name.textContent = c.name || '未命名';
    name.addEventListener('click', () => {
      // Seek the video to clip start time
      const vid = document.querySelector('#modal-media video');
      if (vid) vid.currentTime = c.start_time;
    });

    const time = document.createElement('span');
    time.style.cssText = 'font-family:monospace;font-size:0.75rem;color:var(--text-light);';
    time.textContent = fmtTs(c.start_time) + '–' + fmtTs(c.end_time);

    const meta = document.createElement('span');
    meta.style.cssText = 'font-size:0.73rem;color:var(--text-light);margin-left:auto;';
    meta.textContent = (c.nickname || '匿名') + ' · ❤️' + (c.like_count || 0);

    if (c.is_featured) {
      const feat = document.createElement('span');
      feat.style.cssText = 'font-size:0.65rem;background:#FCF3CF;color:#B7950B;padding:0.1rem 0.3rem;border-radius:999px;font-weight:600;';
      feat.textContent = '精选';
      header.appendChild(feat);
    }

    header.append(name, time, meta);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:0.3rem;';

    const likeBtn = document.createElement('button');
    likeBtn.style.cssText = 'font-size:0.7rem;padding:0.15rem 0.4rem;border-radius:999px;border:1px solid #e0e0e0;background:white;cursor:pointer;';
    likeBtn.textContent = '❤️';
    likeBtn.addEventListener('click', () => clipLike(c.id, likeBtn));

    const dlBtn = document.createElement('button');
    dlBtn.style.cssText = 'font-size:0.7rem;padding:0.15rem 0.4rem;border-radius:999px;border:1px solid #e0e0e0;background:white;cursor:pointer;';
    dlBtn.textContent = '⬇';
    dlBtn.addEventListener('click', () => showClipExport(c));

    actions.append(likeBtn, dlBtn);
    card.append(header, actions);
    return card;
  }));
}

async function clipLike(clipId, btn) {
  await ensureClipIdentity();
  if (!clipIdentity) return;
  btn.disabled = true;
  try {
    let resp = await fetch('/api/clips/' + encodeURIComponent(clipId) + '/like', { method: 'DELETE' });
    if (resp.status === 404) {
      resp = await fetch('/api/clips/' + encodeURIComponent(clipId) + '/like', { method: 'POST' });
    }
    if (resp.ok && state.currentPreview) loadClipPanel(state.currentPreview);
  } catch (_) {} finally { btn.disabled = false; }
}

function showClipExport(c) {
  const file = state.currentPreview;
  if (!file) return;
  const start = c.start_time || 0;
  const dur = (c.end_time || 0) - start;
  const name = (c.name || 'clip') + '.mp4';
  const cmd = 'ffmpeg -ss ' + start + ' -i "' + location.origin + '/api/file/' +
    encodePath(file.key) + '" -t ' + dur.toFixed(1) + ' -c copy "' + name + '"';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:10001;';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const dlg = document.createElement('div');
  dlg.style.cssText = 'background:white;border-radius:12px;padding:1.25rem;max-width:520px;width:90vw;box-shadow:0 8px 30px rgba(0,0,0,0.2);';
  dlg.innerHTML = '<h3 style="margin-bottom:0.5rem;">⬇ ' + (c.name || '切片').replace(/</g,'&lt;') + '</h3>' +
    '<p style="font-size:0.8rem;color:#7A7A7A;margin-bottom:0.5rem;">ffmpeg 命令（下载并裁剪高质量原片）：</p>' +
    '<pre style="background:#1a1a1a;color:#0f0;padding:0.6rem;border-radius:6px;font-size:0.75rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:8rem;overflow-y:auto;">' + cmd.replace(/</g,'&lt;') + '</pre>' +
    '<p style="font-size:0.75rem;color:#7A7A7A;margin-bottom:0.75rem;">需要 <code>ffmpeg</code>。-c copy 不重新编码，最快且无损。</p>' +
    '<div style="display:flex;gap:0.4rem;">' +
    '<button id="cp-cmd" style="padding:0.4rem 0.8rem;border-radius:999px;border:none;background:#B5E8F7;cursor:pointer;font-size:0.8rem;">📋 复制</button>' +
    '<button id="close-dlg" style="padding:0.4rem 0.8rem;border-radius:999px;border:none;background:#f0f0f0;cursor:pointer;font-size:0.8rem;">关闭</button>' +
    '</div>';

  overlay.appendChild(dlg);
  document.body.appendChild(overlay);

  dlg.querySelector('#cp-cmd').addEventListener('click', () => {
    navigator.clipboard.writeText(cmd).then(() => {
      const b = dlg.querySelector('#cp-cmd');
      b.textContent = '✅ 已复制!';
      setTimeout(() => { b.textContent = '📋 复制'; }, 2000);
    }).catch(() => alert('复制失败，请手动复制。'));
  });
  dlg.querySelector('#close-dlg').addEventListener('click', () => overlay.remove());
}

function fmtTs(s) {
  if (s == null || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// ── Start ──
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
