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
    updateLoadMore(data.files.length < data.limit);
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
    img.alt = file.key;
    img.loading = 'lazy';
    img.onerror = () => { img.outerHTML = placeholderHTML('🖼️'); };
    img.onclick = () => openPreview(file);
    thumb.appendChild(img);
  } else if (ct.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.className = 'card-thumb';
    vid.src = `/api/file/${encodePath(file.key)}`;
    vid.muted = true;
    vid.preload = 'metadata';
    vid.onerror = () => { vid.outerHTML = placeholderHTML('🎬'); };
    vid.onclick = () => openPreview(file);
    thumb.appendChild(vid);
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
  name.textContent = file.key.split('/').pop() || file.key;
  name.title = file.key;

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

  dom.modalFilename.textContent = file.key.split('/').pop() || file.key;
  dom.modalMedia.innerHTML = '';

  const ct = file.content_type || '';
  const url = `/api/file/${encodePath(file.key)}`;

  if (ct.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.key;
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
    dom.modalMedia.appendChild(vid);
  } else if (ct.startsWith('audio/')) {
    const wrapper = document.createElement('div');
    wrapper.style.textAlign = 'center';
    wrapper.style.padding = '2rem';

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

function closePreview() {
  state.previewOpen = false;
  state.currentPreview = null;
  dom.previewModal.hidden = true;
  dom.modalMedia.innerHTML = '';
  document.body.style.overflow = '';
}

// ── Download ──
function downloadFile(file) {
  const url = `/api/file/${encodePath(file.key)}?download=1`;
  const a = document.createElement('a');
  a.href = url;
  a.download = file.key.split('/').pop() || file.key;
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
