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
  // Playback sources for the open preview: the original plus any proxies.
  sources: [],
  activeSource: null,
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
  dom.sourceSelector = document.getElementById('source-selector');
  dom.sourceSelect = document.getElementById('source-select');
  dom.sourceNote = document.getElementById('source-note');
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
  dom.sourceSelect?.addEventListener('change', () => {
    const i = parseInt(dom.sourceSelect.value, 10);
    if (state.sources && state.sources[i]) selectSource(state.sources[i]);
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

  dom.clipRank = document.getElementById('clip-rank');
  dom.clipRankList = document.getElementById('clip-rank-list');
  dom.rankTabLikes = document.getElementById('rank-tab-likes');
  dom.rankTabTime = document.getElementById('rank-tab-time');
  dom.rankMore = document.getElementById('rank-more');

  dom.rankTabLikes?.addEventListener('click', () => setRankSort('likes'));
  dom.rankTabTime?.addEventListener('click', () => setRankSort('time'));
  dom.rankMore?.addEventListener('click', () => loadRank(false));

  dom.notices = document.getElementById('notices');
  dom.noticeFeed = document.getElementById('notice-feed');

  // Initial load
  fetchFiles();
  loadRank(true);
  loadNotices();
}

// ── Announcements ──
// Admin-written text, plus whatever it carries: images and video render inline,
// anything else is offered as a download. Failure is silent on purpose — the
// gallery is the page's job, and an announcement that cannot be fetched must
// not put an error box above it.
async function loadNotices() {
  try {
    const resp = await fetch('/api/announcements');
    if (!resp.ok) return;
    const data = await resp.json();
    renderNotices(data.announcements || []);
  } catch (_) { /* the gallery below is unaffected */ }
}

function renderNotices(items) {
  if (!items.length) return;
  dom.noticeFeed.replaceChildren(...items.map(noticeCard));
  dom.notices.hidden = false;
}

// Every string here goes in through textContent, and the media below is only
// ever <img>/<video>/<audio> or an <a download> — never an <iframe> or <object>.
// This renders on the same origin as /admin, and `/api/file/*key` deliberately
// serves anything non-media as application/octet-stream, so an embed that
// *executes* its content is the one thing that would reopen that hole.
function noticeCard(a) {
  const card = document.createElement('article');
  card.className = 'notice-card' + (a.pinned ? ' pinned' : '');

  const head = document.createElement('div');
  head.className = 'notice-head';
  if (a.pinned) {
    const pin = document.createElement('span');
    pin.className = 'notice-pin';
    pin.textContent = '📌';
    pin.title = '置顶';
    head.append(pin);
  }
  if (a.title) {
    const h = document.createElement('h3');
    h.className = 'notice-title';
    h.textContent = a.title;
    head.append(h);
  }
  const time = document.createElement('time');
  time.className = 'notice-date';
  time.textContent = formatNoticeDate(a.created_at);
  head.append(time);
  card.append(head);

  if (a.body) {
    const body = document.createElement('div');
    body.className = 'notice-body';
    body.textContent = a.body;
    card.append(body);
    // Only long notices get the toggle. A three-line notice with a 展开 button
    // under it reads as if something is being withheld.
    if (a.body.length > 240) {
      body.classList.add('clamped');
      const more = document.createElement('button');
      more.className = 'notice-more';
      more.textContent = '展开全文';
      more.addEventListener('click', () => {
        const clamped = body.classList.toggle('clamped');
        more.textContent = clamped ? '展开全文' : '收起';
      });
      card.append(more);
    }
  }

  const media = (a.media || []);
  if (media.length) {
    const box = document.createElement('div');
    box.className = 'notice-media';
    box.append(...media.map(noticeMedia));
    card.append(box);
  }
  return card;
}

// The stored content type decides the element: there is no `kind` column, and
// there does not need to be one — a poster is an image because it is an image.
// Anything the gallery cannot show inline becomes a download, which is also the
// fallback for a type nobody anticipated.
function noticeMedia(m) {
  const url = `/api/file/${encodePath(m.key)}`;
  const type = m.content_type || '';
  const wrap = document.createElement('figure');
  wrap.className = 'notice-media-item';

  if (type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = m.label || m.filename || '';
    img.loading = 'lazy';
    wrap.append(img);
  } else if (type.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = url;
    vid.controls = true;
    vid.preload = 'metadata';
    // No autoplay: an announcement is above the gallery, and a video that
    // starts itself on every page load is the reason people close the tab.
    wrap.append(vid);
  } else if (type.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.preload = 'metadata';
    wrap.append(audio);
  } else {
    const name = m.filename || m.key.split('/').pop() || 'download';
    const link = document.createElement('a');
    link.className = 'notice-file';
    // `&name=` is what turns the opaque storage key into a real filename —
    // /api/file cannot derive one (migration 0002).
    link.href = `${url}?download=1&name=${encodeURIComponent(name)}`;
    link.download = name;
    link.textContent = `📎 ${m.label || name}`;
    if (m.size) link.append(mkNoticeSize(m.size));
    wrap.append(link);
    return wrap;
  }

  if (m.label) {
    const cap = document.createElement('figcaption');
    cap.textContent = m.label;
    wrap.append(cap);
  }
  return wrap;
}

function mkNoticeSize(size) {
  const s = document.createElement('span');
  s.className = 'notice-file-size';
  s.textContent = ' · ' + formatFileSize(size);
  return s;
}

// D1 writes `datetime('now')`, i.e. "YYYY-MM-DD HH:MM:SS" in UTC with no zone
// marker — which Safari refuses to parse and Chrome reads as *local* time. So
// the date is taken apart as text rather than handed to `Date`: the day is what
// a notice needs, and a wrong-by-hours timestamp is worse than no clock.
function formatNoticeDate(raw) {
  return (raw || '').split(' ')[0] || '';
}

// ── Clip rank ──
// A leaderboard of public clips across every file, which is a different axis
// from the gallery below it (one row per source file). `/api/clips` with no
// `file_path` already returns exactly this, sorted by likes or recency; the
// only thing it was missing was the file's R2 key, without which a row here
// could be listed but neither played nor cut. That is what `file_key` on the
// clip record is for.
//
// Set members are deliberately included — someone browsing a leaderboard wants
// the best moments, not a lesson in how they were grouped. The clip page's
// shared area is where grouping matters, and that one passes `loose=1`.
const rank = { sort: 'likes', offset: 0, limit: 20, loading: false, items: [] };

function setRankSort(sort) {
  if (rank.sort === sort || rank.loading) return;
  rank.sort = sort;
  dom.rankTabLikes.classList.toggle('active', sort === 'likes');
  dom.rankTabTime.classList.toggle('active', sort === 'time');
  dom.rankTabLikes.setAttribute('aria-selected', String(sort === 'likes'));
  dom.rankTabTime.setAttribute('aria-selected', String(sort === 'time'));
  loadRank(true);
}

async function loadRank(reset) {
  if (rank.loading) return;
  rank.loading = true;
  if (reset) { rank.offset = 0; rank.items = []; }
  if (dom.rankMore) dom.rankMore.disabled = true;

  try {
    const params = new URLSearchParams({ sort: rank.sort, offset: rank.offset, limit: rank.limit });
    const resp = await fetch('/api/clips?' + params);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const clips = data.clips || [];
    rank.items = rank.items.concat(clips);
    rank.offset += rank.limit;
    // A short page is the last one — same rule the gallery's load-more uses.
    if (dom.rankMore) dom.rankMore.hidden = clips.length < rank.limit;
    renderRank();
  } catch (err) {
    // The rank is an extra, not the point of the page: if it fails, hide it
    // rather than push an error banner above the gallery that still works.
    if (!rank.items.length && dom.clipRank) dom.clipRank.hidden = true;
    console.error('clip rank:', err);
  } finally {
    rank.loading = false;
    if (dom.rankMore) dom.rankMore.disabled = false;
  }
}

function renderRank() {
  if (!dom.clipRank) return;
  if (!rank.items.length) { dom.clipRank.hidden = true; return; }
  dom.clipRank.hidden = false;
  dom.clipRankList.replaceChildren(...rank.items.map(rankRow));
}

// DOM APIs throughout: every string here (clip name, description, nickname,
// file path) is text a stranger typed.
function rankRow(c, i) {
  const row = document.createElement('div');
  row.className = 'rank-row';

  const pos = document.createElement('span');
  pos.className = 'rank-pos';
  // Only meaningful under the likes ordering; under 最新 it is just a counter,
  // so the medals stay off.
  pos.textContent = rank.sort === 'likes' && i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);
  if (rank.sort === 'likes' && i < 3) pos.classList.add('medal');

  const main = document.createElement('div');
  main.className = 'rank-main';

  const title = document.createElement('div');
  title.className = 'rank-name';
  title.textContent = c.name || '未命名片段';
  title.title = c.name || '';
  if (c.is_featured) {
    const b = document.createElement('span');
    b.className = 'rank-badge';
    b.textContent = '精选';
    title.appendChild(b);
  }

  const meta = document.createElement('div');
  meta.className = 'rank-meta';
  const who = document.createElement('span');
  who.textContent = c.nickname || '匿名';
  const time = document.createElement('span');
  time.className = 'rank-time';
  time.textContent = fmtTs(c.start_time) + '–' + fmtTs(c.end_time);
  const from = document.createElement('span');
  from.className = 'rank-from';
  const fileName = (c.file_path || '').split('/').pop() || c.file_path || '';
  from.textContent = '📁 ' + fileName;
  from.title = c.file_path || '';
  meta.append(who, time, from);

  main.append(title, meta);
  if ((c.description || '').trim()) {
    const d = document.createElement('div');
    d.className = 'rank-desc';
    d.textContent = c.description.trim();
    d.title = c.description.trim();
    main.appendChild(d);
  }

  const acts = document.createElement('div');
  acts.className = 'rank-actions';

  const like = document.createElement('button');
  like.className = 'rank-like' + (c.liked ? ' liked' : '');
  like.textContent = (c.liked ? '💖 ' : '🤍 ') + (c.like_count || 0);
  like.title = c.liked ? '取消赞' : '赞';
  like.addEventListener('click', () => toggleRankLike(c, like));
  acts.appendChild(like);

  // A clip whose file has been deleted still lists (its author should be able
  // to see it), but there is nothing left to play or cut.
  if (c.file_key) {
    const play = document.createElement('button');
    play.className = 'rank-btn';
    play.textContent = '▶';
    play.title = '播放这一段';
    play.addEventListener('click', () => playRankClip(c));
    const dl = document.createElement('button');
    dl.className = 'rank-btn';
    dl.textContent = '⬇';
    dl.title = '导出';
    dl.addEventListener('click', () => {
      // showClipExport reads state.currentPreview for the file, so give it one
      // without opening the modal.
      state.currentPreview = rankFile(c);
      showClipExport(c);
    });
    acts.append(play, dl);
  } else {
    const gone = document.createElement('span');
    gone.className = 'rank-gone';
    gone.textContent = '源文件已删除';
    acts.appendChild(gone);
  }

  row.append(pos, main, acts);
  return row;
}

// The clip record carries the file's columns, so the preview modal can be fed
// without a second round trip to /api/files.
function rankFile(c) {
  return {
    key: c.file_key,
    path: c.file_path,
    content_type: c.file_content_type || 'video/mp4',
    size: c.file_size || 0,
  };
}

function playRankClip(c) {
  openPreview(rankFile(c));
  // Seek once the element knows how long it is — setting currentTime before
  // metadata arrives is silently dropped.
  const media = dom.modalMedia.querySelector('video, audio');
  if (!media) return;
  const seek = () => { try { media.currentTime = c.start_time || 0; } catch (_) {} };
  if (media.readyState >= 1) seek();
  else media.addEventListener('loadedmetadata', seek, { once: true });
  media.play().catch(() => {});
}

async function toggleRankLike(c, btn) {
  await ensureClipIdentity();
  if (!clipIdentity) return;
  btn.disabled = true;
  try {
    const resp = await fetch('/api/clips/' + encodeURIComponent(c.id) + '/like',
      { method: c.liked ? 'DELETE' : 'POST' });
    if (resp.ok) {
      // Patch in place instead of refetching: under 最热 a refetch would reorder
      // the list under the cursor, and the tap that caused it would land on a
      // different clip than the one that was pressed.
      c.liked = c.liked ? 0 : 1;
      c.like_count = Math.max(0, (c.like_count || 0) + (c.liked ? 1 : -1));
      btn.textContent = (c.liked ? '💖 ' : '🤍 ') + c.like_count;
      btn.title = c.liked ? '取消赞' : '赞';
      btn.classList.toggle('liked', !!c.liked);
    }
  } catch (_) {} finally { btn.disabled = false; }
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
  // The original is always source 0 and is what paints first. Proxies arrive
  // asynchronously and only add options — this function stays synchronous so
  // the modal never waits on a network round trip before showing anything.
  state.sources = [{
    key: file.key,
    label: '📀 原片',
    size: file.size,
    contentType: ct,
    isOriginal: true,
  }];
  state.activeSource = state.sources[0];
  if (dom.sourceSelector) dom.sourceSelector.hidden = true;
  if (ct.startsWith('video/') || ct.startsWith('audio/')) loadSources(file);

  // Show clip button for video/audio, hide for images
  if (dom.modalClipBtn) {
    dom.modalClipBtn.hidden = !(ct.startsWith('video/') || ct.startsWith('audio/'));
  }
  if (dom.clipPanel) dom.clipPanel.hidden = true;

  renderPreviewMedia(file, state.activeSource);

  dom.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Builds the player for one source. Split out of openPreview so switching
// sources can rebuild it — an audio-only proxy needs an <audio> element and a
// video one needs <video>, so a kind change cannot be a plain `src` swap.
function renderPreviewMedia(file, source) {
  const ct = source.contentType || '';
  const url = `/api/file/${encodePath(source.key)}`;
  dom.modalMedia.innerHTML = '';

  if (ct.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = displayName(file);
    dom.modalMedia.appendChild(img);
  } else if (ct.startsWith('audio/')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'modal-audio-wrap';

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
    wrapper.appendChild(audio);

    dom.modalMedia.appendChild(wrapper);
  } else {
    const vid = document.createElement('video');
    vid.src = url;
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    // Videos are served as video/mp4 whatever codec is inside, so there is no
    // way to know up front whether this browser can decode them — HEVC plays in
    // Safari everywhere and in Chrome only where the OS supplies a hardware
    // decoder. Let the element try, and catch the one error that means
    // "cannot decode at all" so the user gets a download instead of a black box.
    vid.addEventListener('error', () => {
      if (!vid.error || vid.error.code !== vid.error.MEDIA_ERR_SRC_NOT_SUPPORTED) return;
      // The event can land after the user moved on; don't overwrite whatever
      // the modal is showing now.
      if (state.currentPreview !== file || state.activeSource !== source) return;
      dom.modalMedia.replaceChildren(unplayableNotice(file));
    });
    dom.modalMedia.appendChild(vid);
  }
}

// ── Playback sources ──
// Proxies are public (`/api/proxy`), so the gallery can offer them as
// alternative sources: a 360p re-encode plays on a phone connection where the
// original will not, and an audio-only proxy is a fraction of the bytes.
async function loadSources(file) {
  let proxies = [];
  try {
    const resp = await fetch(`/api/proxy?file_path=${encodeURIComponent(displayPath(file))}`);
    if (resp.ok) proxies = (await resp.json()).proxies || [];
  } catch (_) { /* the original is already playing; a failure costs nothing */ }

  // The modal may have been closed or moved on while this was in flight.
  if (!state.previewOpen || state.currentPreview !== file) return;
  if (!proxies.length || !dom.sourceSelector) return;

  for (const p of proxies) {
    const isAudio = (p.content_type || '').startsWith('audio/');
    state.sources.push({
      key: p.key,
      label: `${isAudio ? '🎵' : '🎬'} ${p.label || '代理'}`,
      size: p.size,
      contentType: p.content_type || '',
      isOriginal: false,
    });
  }

  // `new Option` rather than innerHTML — labels are admin-entered text on a
  // public page and would otherwise be parsed as markup.
  dom.sourceSelect.replaceChildren(...state.sources.map((s, i) =>
    new Option(`${s.label} (${formatFileSize(s.size)})`, String(i))));
  dom.sourceSelect.value = String(state.sources.indexOf(state.activeSource));
  dom.sourceSelector.hidden = false;
  updateSourceNote();
}

function updateSourceNote() {
  if (!dom.sourceNote) return;
  const s = state.activeSource;
  dom.sourceNote.textContent = s && !s.isOriginal ? '下载将取此来源' : '';
}

// Switches the playing source, keeping the position so changing quality
// mid-watch does not restart from zero.
function selectSource(source) {
  const file = state.currentPreview;
  if (!file) return;
  const media = dom.modalMedia.querySelector('video, audio');
  const wasAudio = !!state.activeSource && state.activeSource.contentType.startsWith('audio/');
  const isAudio = (source.contentType || '').startsWith('audio/');
  const at = media ? media.currentTime : 0;
  const playing = media ? !media.paused : true;

  state.activeSource = source;
  updateSourceNote();

  // A kind change needs a different element, and so does recovering from the
  // unplayable notice (which replaced the player entirely).
  if (!media || wasAudio !== isAudio) {
    renderPreviewMedia(file, source);
  } else {
    media.src = `/api/file/${encodePath(source.key)}`;
  }

  const next = dom.modalMedia.querySelector('video, audio');
  if (!next) return;
  next.addEventListener('loadedmetadata', () => {
    // A proxy is a re-encode of the same timeline, so the position carries over.
    if (at && at < next.duration) next.currentTime = at;
    if (playing) next.play().catch(() => {});
  }, { once: true });
}

// Replacement for a <video> the browser refused to decode. The file is served as
// video/mp4 whatever is inside it, so instead of guessing the codec we show what
// this device can decode and let the mismatch speak for itself.
//
// The codec table and the probe live in `codecs.js`, shared with the clip page —
// both pages have a player that can be handed an undecodable file, and the
// answer has to be the same on both.
function unplayableNotice(file) {
  const box = document.createElement('div');
  box.className = 'media-unplayable';
  box.append(...VideoCodecs.buildPanel());

  const btn = document.createElement('button');
  btn.textContent = '⬇ 下载原文件';
  btn.addEventListener('click', () => downloadFile(file));

  box.appendChild(btn);
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
  // Follows the source picker: choosing 360p and hitting 💾 should give you the
  // 360p bytes, not the original. Falls back to the file itself for images and
  // for any call made outside the preview.
  const source = (state.currentPreview === file && state.activeSource) || null;
  const key = source ? source.key : file.key;
  // The storage key is opaque, so the download name travels in the query string;
  // the worker turns it into Content-Disposition.
  let name = displayName(file);
  if (source && !source.isOriginal) {
    // Distinguish the file on disk from the original, which may already be
    // sitting in the same downloads folder under the plain name.
    const dot = name.lastIndexOf('.');
    const tag = source.label.replace(/^\S+\s*/, '').trim() || 'proxy';
    name = dot > 0 ? `${name.slice(0, dot)}-${tag}${name.slice(dot)}` : `${name}-${tag}`;
  }
  const url = `/api/file/${encodePath(key)}?download=1&name=${encodeURIComponent(name)}`;
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
    // No identity — get a silent one. Sending no `nickname` key at all leaves
    // any nickname chosen on the clip page alone (the server only renames when
    // the field is present).
    const idResp = await fetch('/api/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
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
  dom.clipPanelList.innerHTML = '<div class="clip-panel-status">加载中...</div>';
  // `size` lets the clip page rank the original against the proxies when it
  // picks a default preview source; without it the original is treated as
  // unknown-and-largest, which is the safe assumption for a proxy anyway.
  dom.clipPageLink.href = '/clip?file=' + encodeURIComponent(displayPath(file)) +
    '&key=' + encodeURIComponent(file.key) +
    '&type=' + ((file.content_type || '').startsWith('audio/') ? 'audio' : 'video') +
    (file.size ? '&size=' + encodeURIComponent(file.size) : '');

  try {
    const resp = await fetch('/api/clips?file_path=' + encodeURIComponent(displayPath(file)) + '&sort=likes&limit=50');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    renderClipPanel(data.clips || []);
  } catch (err) {
    const st = document.createElement('div');
    st.className = 'clip-panel-status err';
    st.textContent = '加载失败: ' + err.message;
    dom.clipPanelList.replaceChildren(st);
  }
}

function renderClipPanel(clips) {
  if (!clips.length) {
    const st = document.createElement('div');
    st.className = 'clip-panel-status';
    const a = document.createElement('a');
    a.href = dom.clipPageLink.href;
    a.textContent = '切片页面';
    st.append(document.createTextNode('暂无切片。去 '), a, document.createTextNode(' 创建第一个！'));
    dom.clipPanelList.replaceChildren(st);
    return;
  }
  dom.clipPanelList.replaceChildren(...clips.map(c => {
    const card = document.createElement('div');
    card.className = 'clip-panel-item';

    const header = document.createElement('div');
    header.className = 'clip-panel-head';

    const name = document.createElement('span');
    name.className = 'clip-panel-name';
    name.textContent = c.name || '未命名';
    name.addEventListener('click', () => {
      // Seek the video to clip start time
      const vid = document.querySelector('#modal-media video');
      if (vid) vid.currentTime = c.start_time;
    });

    const time = document.createElement('span');
    time.className = 'clip-panel-time';
    time.textContent = fmtTs(c.start_time) + '–' + fmtTs(c.end_time);

    const meta = document.createElement('span');
    meta.className = 'clip-panel-meta';
    meta.textContent = (c.nickname || '匿名') + ' · ❤️' + (c.like_count || 0);

    if (c.is_featured) {
      const feat = document.createElement('span');
      feat.className = 'clip-panel-badge';
      feat.textContent = '精选';
      header.appendChild(feat);
    }

    header.append(name, time, meta);

    const actions = document.createElement('div');
    actions.className = 'clip-panel-actions';

    const likeBtn = document.createElement('button');
    likeBtn.textContent = c.liked ? '💖' : '🤍';
    likeBtn.title = c.liked ? '取消赞' : '赞';
    likeBtn.addEventListener('click', () => clipLike(c, likeBtn));

    const dlBtn = document.createElement('button');
    dlBtn.title = '导出';
    dlBtn.textContent = '⬇';
    dlBtn.addEventListener('click', () => showClipExport(c));

    actions.append(likeBtn, dlBtn);
    card.append(header, actions);
    return card;
  }));
}

// `c.liked` is computed server-side from the identity cookie. Probing with a
// DELETE and retrying on 404 never worked — unlike always answers 200, so the
// POST branch was unreachable and nothing could ever be liked from here.
async function clipLike(c, btn) {
  await ensureClipIdentity();
  if (!clipIdentity) return;
  btn.disabled = true;
  try {
    const resp = await fetch('/api/clips/' + encodeURIComponent(c.id) + '/like', { method: c.liked ? 'DELETE' : 'POST' });
    if (resp.ok && state.currentPreview) loadClipPanel(state.currentPreview);
  } catch (_) {} finally { btn.disabled = false; }
}

// Single-quote every interpolated value: this line is pasted into a shell, and
// `c.name` is attacker-supplied text from someone else's public clip. Inside
// '…' the shell expands nothing.
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function showClipExport(c) {
  const file = state.currentPreview;
  if (!file) return;
  const start = c.start_time || 0;
  const dur = (c.end_time || 0) - start;
  const name = (c.name || 'clip') + '.mp4';
  const cmd = 'ffmpeg -ss ' + Number(start).toFixed(1) +
    ' -i ' + shellQuote(location.origin + '/api/file/' + encodePath(file.key)) +
    ' -t ' + dur.toFixed(1) + ' -c copy ' + shellQuote(name);

  // Built with DOM APIs, not innerHTML: `c.name` is free text from a stranger's
  // public clip, and the `<`-only escape this used to do leaves quotes and HTML
  // entities intact. Same rule the list rows follow.
  const overlay = document.createElement('div');
  overlay.className = 'clip-export-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay && !busy) overlay.remove(); });

  const dlg = document.createElement('div');
  dlg.className = 'clip-export-dialog';

  const h = document.createElement('h3');
  h.textContent = '⬇ ' + (c.name || '切片');
  dlg.appendChild(h);

  // One-click first — the ffmpeg command below it is the fallback, not the
  // headline. The cut runs in the page against the HQ original; see mp4clip.js.
  const quick = document.createElement('div');
  quick.className = 'clip-export-quick';
  const dlBtn = document.createElement('button');
  dlBtn.className = 'clip-export-btn primary';
  dlBtn.textContent = '⬇ 一键下载（浏览器直接剪切）';
  dlBtn.disabled = true;
  const note = document.createElement('p');
  note.className = 'clip-export-note';
  note.textContent = '正在读取索引…';
  const bar = document.createElement('div');
  bar.className = 'clip-export-bar';
  bar.hidden = true;
  const fill = document.createElement('span');
  bar.appendChild(fill);
  quick.append(dlBtn, note, bar);
  dlg.appendChild(quick);

  const p1 = document.createElement('p');
  p1.className = 'clip-export-note';
  p1.textContent = 'ffmpeg 命令（下载并裁剪高质量原片）：';
  const pre = document.createElement('pre');
  pre.className = 'clip-export-cmd';
  pre.textContent = cmd;
  const p2 = document.createElement('p');
  p2.className = 'clip-export-note';
  p2.textContent = '需要 ffmpeg。-c copy 不重新编码，最快且无损。';
  dlg.append(p1, pre, p2);

  const row = document.createElement('div');
  row.className = 'clip-export-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'clip-export-btn';
  copyBtn.textContent = '📋 复制';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'clip-export-btn ghost';
  closeBtn.textContent = '关闭';
  row.append(copyBtn, closeBtn);
  dlg.appendChild(row);

  overlay.appendChild(dlg);
  document.body.appendChild(overlay);

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd).then(() => {
      copyBtn.textContent = '✅ 已复制!';
      setTimeout(() => { copyBtn.textContent = '📋 复制'; }, 2000);
    }).catch(() => alert('复制失败，请手动复制。'));
  });
  closeBtn.addEventListener('click', () => { if (!busy) overlay.remove(); });

  let plan = null, busy = false;
  (async () => {
    if (!window.MP4Clip) { note.textContent = '浏览器剪切不可用，请使用上面的 ffmpeg 命令。'; return; }
    const src = await MP4Clip.open('/api/file/' + encodePath(file.key));
    if (!src.ok) { note.textContent = src.reason + '，请使用下面的 ffmpeg 命令。'; return; }
    const p = MP4Clip.plan(src, start, c.end_time || 0);
    if (!p.ok) { note.textContent = p.reason + '，请使用下面的 ffmpeg 命令。'; return; }
    plan = p;
    dlBtn.disabled = false;
    note.textContent = '约 ' + formatFileSize(p.bytes) + '，无需重新编码'
      + (p.snapped ? ' · 起点对齐到关键帧 ' + fmtTs(p.actualStart) : '');
  })();

  dlBtn.addEventListener('click', async () => {
    if (!plan || busy) return;
    busy = true; dlBtn.disabled = true; bar.hidden = false;
    const label = dlBtn.textContent;
    dlBtn.textContent = '正在剪切…';
    const total = plan.fetchBytes + plan.bytes;
    try {
      const blob = await MP4Clip.render(plan, {
        onProgress: ev => {
          const done = ev.phase === 'fetch' ? ev.loaded : plan.fetchBytes + ev.loaded;
          fill.style.width = Math.round((done / total) * 100) + '%';
        }
      });
      MP4Clip.saveBlob(blob, MP4Clip.safeName(c.name || '切片', plan.ext));
      note.textContent = '✅ 已保存（' + formatFileSize(blob.size) + '）';
    } catch (err) {
      note.textContent = '剪切失败：' + (err && err.message || err) + '，请使用下面的 ffmpeg 命令。';
    } finally {
      busy = false; bar.hidden = true; fill.style.width = '0%';
      dlBtn.textContent = label; dlBtn.disabled = false;
    }
  });
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
