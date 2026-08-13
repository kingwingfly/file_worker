'use strict';

const fileInput = document.getElementById('file-input');
const uploadZone = document.getElementById('upload-zone');
const uploadBtn = document.getElementById('upload-btn');
const uploadResult = document.getElementById('upload-result');
const customPath = document.getElementById('custom-path');
const fileListEl = document.getElementById('admin-file-list');
const attachTargetSelect = document.getElementById('attach-target');
const attachLabelInput = document.getElementById('attach-label');
let selectedFiles = [];

// ── Upload mode ──
// 'file' uploads a new object; 'proxy' attaches a low-quality playback source
// to an existing one; 'attachment' attaches a downloadable related file
// (subtitles, transcripts); 'cover' sets a file's gallery poster;
// 'announcement' attaches an image, video or PDF to an announcement.
// Everything between /start and /complete is identical —
// /admin/api/upload/part serves all of them — so they share this whole
// uploader, queue, resume and wake lock included.
//
// Every mode test goes through `attachSpec()`, never a bare `=== 'proxy'`.
// With only two modes, `=== 'proxy'` doubled as "not a plain file upload";
// a third mode makes every such test silently reclassify attachments as file
// uploads, and in `uploadLanded` that mistake costs real data. A legacy
// session with no `mode` at all still resolves to null, i.e. a file upload.
//
// `targetParam` is what an attach mode is bound *to*, and it is not always a
// file: proxies and attachments hang off `files.path`, announcement media off
// an `announcements.id`. Every request that carries the target — /start,
// /complete, the listing behind `uploadLanded` — names it through this field,
// so a hardcoded `?file_path=` anywhere is a bug that only shows up in the
// announcement mode, and only as a reconcile failure.
const ATTACH_SPECS = {
  proxy: {
    targetParam: 'file_path',
    title: '📹 上传代理',
    accept: 'video/*,audio/*',
    zoneHint: '低质量视频或纯音频，用于快速预览和切片',
    targetLabel: '🎯 代理目标 (为哪个文件上传代理)',
    targetHint: '只列出已上传的视频/音频文件。一个文件可以有多个代理。',
    labelLabel: '🏷 代理标签',
    labelHint: '显示在播放和切片页面的来源选单里。',
    labelPlaceholder: '例如: 360p、纯音频',
    // Mirrors the server's own clamp_text — a longer value would be silently
    // truncated at /complete, so refuse it in the field instead.
    labelMax: 32,
    fallbackLabel: 'proxy',
    startUrl: '/admin/api/proxy/start',
    completeUrl: '/admin/api/proxy/complete',
    listUrl: '/admin/api/proxy',
    listField: 'proxies',
    okPrefix: '✅ 代理上传成功!',
    badge: '📹 代理',
  },
  attachment: {
    targetParam: 'file_path',
    title: '📎 上传关联文件',
    // Deliberately unrestricted: subtitles arrive as .srt/.ass/.vtt/.lrc and
    // the OS file picker's type map for those is unreliable.
    accept: '',
    zoneHint: '字幕、文稿等，供观众在切片页下载后喂给 AI',
    targetLabel: '🎯 关联到哪个文件',
    targetHint: '只列出已上传的视频/音频文件。一个文件可以有多个关联文件。',
    labelLabel: '🏷 关联文件说明',
    labelHint: '显示在切片页的关联文件列表里，例如「中文字幕」。',
    labelPlaceholder: '例如: 中文字幕、全场文稿',
    labelMax: 48,
    fallbackLabel: '关联文件',
    startUrl: '/admin/api/attachment/start',
    completeUrl: '/admin/api/attachment/complete',
    listUrl: '/admin/api/attachment',
    listField: 'attachments',
    okPrefix: '✅ 关联文件上传成功!',
    badge: '📎 关联文件',
  },
  cover: {
    targetParam: 'file_path',
    title: '🖼 上传封面',
    accept: 'image/*',
    zoneHint: '一张图片，作为该文件在画廊里的封面',
    targetLabel: '🎯 为哪个文件设封面',
    targetHint: '视频和音频在画廊里没有画面可显示，封面就是那张图。',
    // A cover has no label of its own — it is one image per file, identified by
    // the file it belongs to. The field stays in the DOM (the section is shared)
    // but nothing reads it; `fallbackLabel` keeps the send path uniform.
    labelLabel: '🏷 备注 (可不填)',
    labelHint: '封面只有一张，这里填什么都不会显示。',
    labelPlaceholder: '',
    labelMax: 48,
    fallbackLabel: 'cover',
    // …and therefore nothing for a queue row to print beside its target.
    labelless: true,
    startUrl: '/admin/api/cover/start',
    completeUrl: '/admin/api/cover/complete',
    listUrl: '/admin/api/cover',
    listField: 'covers',
    okPrefix: '✅ 封面已设置!',
    badge: '🖼 封面',
    // One cover per file, so a multi-select would queue N uploads of which only
    // the last survives — every earlier one would be released again the moment
    // the next completed. The picker stays single-file in this mode alone.
    single: true,
  },
  announcement: {
    targetParam: 'announcement_id',
    title: '📢 上传公告附件',
    // Unrestricted for the same reason as attachments, and because the two
    // kinds an announcement carries are deliberately different: a poster or
    // teaser the feed shows inline, and a document it offers as a download.
    accept: '',
    zoneHint: '图片、视频会显示在公告里，PDF 等文件作为下载提供',
    targetLabel: '🎯 属于哪条公告',
    targetHint: '先在「📢 公告」区新建公告，再回到这里为它上传附件。',
    labelLabel: '🏷 附件说明',
    labelHint: '显示在图片下方或下载按钮上，例如「直播日程表」。',
    labelPlaceholder: '例如: 日程表、场照',
    labelMax: 48,
    fallbackLabel: '附件',
    startUrl: '/admin/api/announcement/start',
    completeUrl: '/admin/api/announcement/complete',
    listUrl: '/admin/api/announcement-media',
    listField: 'media',
    okPrefix: '✅ 公告附件上传成功!',
    badge: '📢 公告附件',
  },
};

function uploadMode() {
  const picked = document.querySelector('input[name="upload-mode"]:checked');
  return picked ? picked.value : 'file';
}

// The one place a mode name turns into behaviour. null means a plain file
// upload — the only mode that mints its own path and needs the check-key pass.
function attachSpec(mode) {
  return ATTACH_SPECS[mode] || null;
}

// The token this upload is attached to — a `files.path` in the proxy and
// attachment modes, an `announcements.id` in the announcement one. Which query
// param it travels under is `spec.targetParam`'s business, not this function's.
//
// The stored field keeps its `attachFilePath` name on purpose: a session
// written by the deployed version is still readable, and so is one written by
// the two-mode version before it (`proxyFilePath`). Renaming the field would
// strand an upload that was in flight when this version shipped.
function sessionAttachTarget(s) { return s.attachFilePath || s.proxyFilePath || ''; }
function sessionAttachLabel(s) { return s.attachLabel || s.proxyLabel || ''; }

function applyUploadMode() {
  const spec = attachSpec(uploadMode());
  document.getElementById('upload-title').textContent = spec ? spec.title : '🍰 上传文件';
  document.getElementById('group-custom-path').hidden = !!spec;
  document.getElementById('group-attach-target').hidden = !spec;
  document.getElementById('group-attach-label').hidden = !spec;
  fileInput.accept = spec ? spec.accept : 'image/*,video/*,audio/*';
  // Multi-select is what makes the queue worth having: one pick, N tasks.
  // Only the cover mode opts out — see `single` in its spec.
  fileInput.multiple = !(spec && spec.single);
  if (spec) {
    document.getElementById('attach-target-label').textContent = spec.targetLabel;
    document.getElementById('attach-target-hint').textContent = spec.targetHint;
    document.getElementById('attach-label-label').textContent = spec.labelLabel;
    document.getElementById('attach-label-hint').textContent = spec.labelHint;
    attachLabelInput.placeholder = spec.labelPlaceholder;
    attachLabelInput.maxLength = spec.labelMax;
  }
  // The target list is per-mode — files for 代理/关联文件, announcements for
  // 公告附件 — so it has to be rebuilt here, not just when a listing loads.
  // Without this the select keeps the previous mode's options and the first
  // upload posts a file path as an `announcement_id`.
  renderAttachTargets();
  if (!selectedFiles.length) {
    document.getElementById('upload-zone-hint').textContent =
      spec ? spec.zoneHint : '支持 JPG, PNG, GIF, MP4, WEBM, MP3, WAV 等';
  }
  refreshUploadButton();
}

// In every attach mode the target is as required as the file itself — without
// one there is nothing to attach the upload to.
function refreshUploadButton() {
  const needsTarget = !!attachSpec(uploadMode()) && !attachTargetSelect.value;
  uploadBtn.disabled = !selectedFiles.length || needsTarget;
}

document.querySelectorAll('input[name="upload-mode"]').forEach(r =>
  r.addEventListener('change', applyUploadMode));
attachTargetSelect.addEventListener('change', refreshUploadButton);

// File selection. The form is now only an *enqueue* form: picking files and
// clicking 上传 hands them to the queue and immediately clears itself, so the
// admin can pick the next batch — in a different mode if they like — while the
// first is still transferring.
function onFilesChosen(list) {
  const files = [...(list || [])];
  if (!files.length) return;
  selectedFiles = files;
  refreshUploadButton();
  document.querySelector('.upload-zone-text').textContent =
    files.length === 1 ? files[0].name : `${files.length} 个文件`;
  const total = files.reduce((n, f) => n + f.size, 0);
  document.getElementById('upload-zone-hint').textContent = files.length === 1
    ? formatSize(total) + ' — ' + (files[0].type || 'unknown')
    : `共 ${formatSize(total)}`;
}

function clearFormSelection() {
  selectedFiles = [];
  fileInput.value = '';
  customPath.value = '';
  document.querySelector('.upload-zone-text').textContent = '点击或拖拽到此处';
  applyUploadMode();  // restores the mode's own zone hint and the button state
}

fileInput.addEventListener('change', () => onFilesChosen(fileInput.files));

// Drag & drop
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (!e.dataTransfer.files.length) return;
  fileInput.files = e.dataTransfer.files;
  onFilesChosen(e.dataTransfer.files);
});

// Screen Wake Lock — a multi-GB upload takes long enough that an idle
// screen timeout would otherwise suspend the machine mid-transfer.
//
// The browser releases the lock by itself whenever the page stops being
// visible, and does not re-take it when the page comes back. The
// visibilitychange handler below is therefore load-bearing, not a nicety:
// without it, one tab switch during a long upload silently ends the lock.
//
// Acquisition is anchored to the click that starts an upload, never to the
// async work that follows it. Every engine documents the gesture-time
// pattern, and WebKit is the one that appears to enforce it: a request
// issued after the check-key round trip has outlived its transient
// activation. Failure is not fatal — the hint says so and the upload runs.
const wakeHint = document.getElementById('wake-hint');
let wakeLock = null;
let wakeLockPending = null;
let wakeLockWanted = false;
// True while *any* task is transferring. With a queue this can no longer be a
// flag one upload owns: task 1 finishing while 2–4 are still running must not
// drop the lock or stop the beforeunload warning, so it is derived from the
// queue by syncActivity() and never assigned anywhere else.
let uploadInProgress = false;

async function acquireWakeLock(site) {
  wakeLockWanted = true;
  if (!('wakeLock' in navigator)) return false;
  // Two callers (upload start, visibilitychange) can race here. Without
  // this guard both requests resolve, the second overwrites `wakeLock`,
  // and the first sentinel is orphaned — the screen then stays awake after
  // the upload finishes, with nothing left holding a reference to release.
  if (wakeLock) return true;
  if (wakeLockPending) {
    try { await wakeLockPending; } catch (_) { /* the first caller logs it */ }
    return !!wakeLock;
  }
  try {
    wakeLockPending = navigator.wakeLock.request('screen');
    wakeLock = await wakeLockPending;
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    // releaseWakeLock() may have run while the request was in flight — the
    // admin cancelled the last queued task, say. It had no sentinel to
    // release then, so honour the intent now instead of leaking this one.
    if (!wakeLockWanted) {
      releaseWakeLock();
      return false;
    }
    console.debug(`Wake lock held (site=${site})`);
    return true;
  } catch (err) {
    // Safari denies with a bare NotAllowedError for several unrelated
    // reasons — Low Power Mode, a hidden or not-yet-fully-active document,
    // an insecure origin — and the message never says which. Log the state
    // that tells them apart, plus which call site asked.
    const detail =
      `site=${site} visibility=${document.visibilityState} secure=${isSecureContext}`;
    if (site === 'visibilitychange' || site === 'gesture') {
      // Both are recovery attempts that are *expected* to fail sometimes —
      // 'visibilitychange' always does on Safari, which has no gesture
      // there, and 'gesture' fires on every click while a lock is missing.
      // The on-page hint covers it; don't shout in the console.
      console.debug(`Wake lock not re-acquired (${err.name}) — ${detail}`);
    } else {
      console.warn(`Wake lock refused (${err.name}: ${err.message}) — ${detail}`);
    }
    wakeLock = null;
    return false;
  } finally {
    wakeLockPending = null;
  }
}

function releaseWakeLock() {
  wakeLockWanted = false;
  if (!wakeLock) return;
  wakeLock.release().catch(() => { /* already gone */ });
  wakeLock = null;
}

function setWakeHint(held) {
  let msg;
  if (!('wakeLock' in navigator)) {
    msg = '⚠️ 此浏览器不支持屏幕常亮，上传期间请勿让设备休眠';
  } else if (held) {
    msg = '☕ 已阻止设备休眠';
  } else {
    // Not "refused". A missing lock here is usually recoverable — Safari
    // only grants one inside a user gesture, and the capture-phase click
    // listener takes the next one and upgrades this message. Say what the
    // admin can do about it rather than announcing a permanent failure.
    msg = '⚠️ 尚未阻止休眠，点击页面任意处重试';
  }
  wakeHint.textContent = msg + ' · 请勿关闭此页面';
  wakeHint.hidden = false;
}

// Report the state a gesture-time request reached, without issuing a new
// request of our own.
async function settleWakeHint() {
  if (wakeLockPending) {
    try { await wakeLockPending; } catch (_) { /* setWakeHint reports it */ }
  }
  setWakeHint(!!wakeLock);
}

document.addEventListener('visibilitychange', () => {
  if (!uploadInProgress || document.visibilityState !== 'visible') return;
  acquireWakeLock('visibilitychange').then(setWakeHint);
});

// Safari grants a lock only inside a user gesture (verified: the same
// request fails from the console and succeeds from a click handler), so the
// re-acquire above cannot work there — a single tab switch would end the
// lock for the rest of the upload. Take the next click anywhere as the
// gesture. Capture phase, so a handler that stops propagation can't hide it.
document.addEventListener('click', () => {
  if (!uploadInProgress || wakeLock) return;
  acquireWakeLock('gesture').then(setWakeHint);
}, true);

// Closing the tab mid-upload kills every running transfer and strands their
// multipart uploads in R2 — the abort call lives in the task's catch, which
// never runs if the page is gone. Warn before that happens.
//
// Browsers deliberately ignore any custom message here and show their own
// generic dialog; the only thing that matters is that a handler cancelled
// the event. Chrome additionally requires the page to have had a user
// gesture, which an upload the admin clicked to start always satisfies.
window.addEventListener('beforeunload', (e) => {
  if (!uploadInProgress) return;
  e.preventDefault();
  e.returnValue = ''; // legacy Chrome/Safari spelling, still needed
});

// ---- Resumable upload sessions -------------------------------------
//
// worker-rs 0.8.5's MultipartUpload exposes only upload_part / abort /
// complete — there is no list_parts — so the server cannot tell a returning
// client which parts already landed. The client is the only place that can
// remember them, which is why the etags live in localStorage.
//
// Written after *every* successful part, not on failure: the usual way an
// upload dies is a closed tab, a crash, or a sleeping machine, and none of
// those reach a catch block.
//
// One storage key per session (`zcll.upload.session.<upload_id>`) plus an
// index of the ids, deliberately not one map under a single key. A map is a
// read-modify-write, and with several tasks writing after every part, one
// `await` between the read and the write silently reverts a sibling's part
// list. Separate keys make each write independent — and stop a 5000-part
// session being re-serialised every time some *other* task lands a part.
const SESSION_PREFIX = 'zcll.upload.session.';
const SESSION_INDEX = 'zcll.upload.sessions';
// What the single-session version wrote. Migrated once, on load, so an upload
// that was in flight when this version shipped is still resumable.
const LEGACY_SESSION_KEY = 'zcll.upload.session';
const PART_RETRIES = 6;          // 1+2+4+8+16s ≈ 31s of backoff
const OFFLINE_WAIT_MS = 120000;  // per offline pause
const MAX_OFFLINE_WAITS = 5;     // ≈10 min of tolerated disconnection

function sessionIds() {
  try { return JSON.parse(localStorage.getItem(SESSION_INDEX) || '[]'); }
  catch (_) { return []; }
}
function writeSessionIds(ids) {
  try { localStorage.setItem(SESSION_INDEX, JSON.stringify(ids)); }
  catch (_) { /* private mode / quota */ }
}
function saveSession(s) {
  if (!s || !s.upload_id) return;
  try {
    localStorage.setItem(SESSION_PREFIX + s.upload_id, JSON.stringify(s));
    const ids = sessionIds();
    if (!ids.includes(s.upload_id)) { ids.push(s.upload_id); writeSessionIds(ids); }
  } catch (_) { /* private mode / quota */ }
}
function loadSession(uploadId) {
  try { return JSON.parse(localStorage.getItem(SESSION_PREFIX + uploadId) || 'null'); }
  catch (_) { return null; }
}
function clearSession(uploadId) {
  try { localStorage.removeItem(SESSION_PREFIX + uploadId); } catch (_) { /* nothing to do */ }
  writeSessionIds(sessionIds().filter(id => id !== uploadId));
}
function loadAllSessions() {
  return sessionIds().map(loadSession).filter(s => s && s.upload_id);
}

function migrateLegacySession() {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY) || 'null'); }
  catch (_) { /* unparseable — nothing to carry over */ }
  try { localStorage.removeItem(LEGACY_SESSION_KEY); } catch (_) { /* ignore */ }
  if (legacy && legacy.upload_id && !loadSession(legacy.upload_id)) saveSession(legacy);
}

// Resuming with the wrong file would splice foreign bytes into the object,
// and nothing downstream would catch it — the parts all have valid etags.
// Match on all three cheap identity signals the File API gives us.
function sessionMatches(s, file) {
  return !!s && !!s.file
    && s.file.name === file.name
    && s.file.size === file.size
    && s.file.lastModified === file.lastModified;
}

function sessionChunks(s) {
  return Math.max(1, Math.ceil(s.file.size / s.chunkSize));
}

async function abortSession(s) {
  if (!s || !s.upload_id || !s.key) return;
  try {
    await fetch(
      `/admin/api/upload?upload_id=${encodeURIComponent(s.upload_id)}&key=${encodePath(s.key)}`,
      { method: 'DELETE' }
    );
  } catch (_) { /* best effort — an R2 lifecycle rule is the real backstop */ }
}

// Part size is bounded from both ends. R2 wants parts ≥5 MB (except the
// last) and at most 10,000 of them. Cloudflare separately drops a request
// whose body arrives too slowly — an undocumented edge timeout that
// surfaces as 408 — so the real ceiling is how much this connection can
// push before the edge stops waiting, not R2's maximum. 25 MB needed
// roughly 7 Mbps sustained to stay inside that window; 8 MB needs about a
// third of that, and a part that does time out is cheaper to resend.
const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = 9000;              // R2 allows 10000; leave headroom
const PART_TIMEOUT_MS = 300000;      // a stalled socket should fail, not hang

// Only grows the part size for files big enough to blow the part count —
// 8 MB covers everything up to 72 GB.
function chunkSizeFor(fileSize) {
  const needed = Math.ceil(fileSize / MAX_PARTS);
  return Math.max(MIN_CHUNK_SIZE, Math.ceil(needed / (1024 * 1024)) * 1024 * 1024);
}

// ---- The upload queue ----------------------------------------------
//
// An upload is a *task*, not a modal state of this page. Clicking 上传 hands
// the picked files to this queue and gives the form straight back, so several
// files — in different modes, against different targets — can be in flight at
// once, and each one can be paused, resumed or cancelled on its own.
//
// Concurrency defaults to 2 and is capped at 4, and that ceiling is not
// arbitrary. The 8 MB part size exists because Cloudflare's edge drops a
// request body that arrives too slowly (the 408 in `isRetryable`), and it was
// picked against the *whole* upstream. N parallel parts divide that upstream
// by N, so each part sits in the timing envelope a part N times its size would
// have: at 4, an 8 MB part is as exposed as the 32 MB one that made 408s
// routine. Raising this trades a slow link's reliability for request count —
// don't, without measuring the upstream first.
const CONCURRENCY_KEY = 'zcll.upload.concurrency';
const MAX_CONCURRENCY = 4;
const DEFAULT_CONCURRENCY = 2;

const taskListEl = document.getElementById('task-list');
const queueSummaryEl = document.getElementById('queue-summary');
const concurrencyInput = document.getElementById('queue-concurrency');
const btnClearFinished = document.getElementById('btn-clear-finished');

const tasks = [];
let maxConcurrent = readConcurrency();

function readConcurrency() {
  const stored = parseInt(localStorage.getItem(CONCURRENCY_KEY) || '', 10);
  if (!Number.isFinite(stored)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, stored));
}

concurrencyInput.max = String(MAX_CONCURRENCY);
concurrencyInput.value = String(maxConcurrent);
concurrencyInput.addEventListener('change', () => {
  maxConcurrent = Math.min(MAX_CONCURRENCY, Math.max(1, parseInt(concurrencyInput.value, 10) || DEFAULT_CONCURRENCY));
  concurrencyInput.value = String(maxConcurrent);
  try { localStorage.setItem(CONCURRENCY_KEY, String(maxConcurrent)); } catch (_) { /* per-page-view only */ }
  // Raising it must take effect now, not at the next completion.
  pump();
});

// The states that hold a concurrency slot: everything from the moment a task
// leaves the queue until it stops touching the network. 'pausing' is in the
// set on purpose — the task is still unwinding an in-flight part, and letting
// a sibling start before it lands would briefly exceed the limit.
const ACTIVE_STATES = new Set(['checking', 'starting', 'uploading', 'completing', 'pausing']);
// States a task can be resumed out of, i.e. where 继续 is offered.
const RESUMABLE_STATES = new Set(['paused', 'error']);

const STATE_TEXT = {
  queued: '⏳ 排队中',
  checking: '🔍 检查重名',
  'awaiting-overwrite': '⚠️ 名称已存在',
  starting: '🚀 创建上传',
  uploading: '⬆️ 上传中',
  pausing: '⏸ 暂停中…',
  paused: '⏸ 已暂停',
  completing: '📦 合并分片',
  done: '✅ 完成',
  error: '⏸ 已中断',
  failed: '❌ 失败',
  'needs-file': '📂 待重新选择文件',
  cancelled: '🚫 已取消',
};

function activeCount() { return tasks.filter(t => ACTIVE_STATES.has(t.state)).length; }

// The single writer for `uploadInProgress`, and therefore for the wake lock's
// lifetime and the beforeunload guard. Called from setState, so no state
// transition can forget it.
function syncActivity() {
  const busy = activeCount() > 0;
  if (busy === uploadInProgress) return;
  uploadInProgress = busy;
  if (busy) {
    settleWakeHint();
  } else {
    // The last task stopped. A paused or interrupted one is not "in progress":
    // its session survives a reload and 继续 re-acquires the lock inside its
    // own click.
    releaseWakeLock();
    setTimeout(() => { if (!uploadInProgress) wakeHint.hidden = true; }, 1500);
  }
}

function setState(task, state) {
  task.state = state;
  renderTask(task);
  syncActivity();
  renderQueueSummary();
}

// The scheduler. Idempotent and cheap, so every state change may call it.
function pump() {
  while (activeCount() < maxConcurrent) {
    const next = tasks.find(t => t.state === 'queued');
    if (!next) break;
    // startTask sets an active state synchronously before it awaits anything —
    // otherwise this loop would hand every slot to the same task.
    startTask(next);
  }
  renderQueueSummary();
}

function enqueue(file, opts) {
  const task = {
    file,
    mode: opts.mode,
    target: opts.target || '',
    label: opts.label || '',
    path: opts.path || '',
    overwrite: false,
    session: null,
    state: 'queued',
    loaded: 0,
    total: file ? file.size : 0,
    note: '',
    error: '',
    xhr: null,
    pauseRequested: false,
    cancelRequested: false,
    dupChecked: false,
  };
  tasks.push(task);
  buildTaskRow(task);
  return task;
}

// A session restored from localStorage has no File — a File handle cannot
// survive a reload — so it lands as a task that is complete in every way
// except the bytes, and asks for the same file back.
function adoptSession(session) {
  const task = {
    file: null,
    mode: session.mode || 'file',
    target: sessionAttachTarget(session),
    label: sessionAttachLabel(session),
    path: session.path || '',
    overwrite: !!session.overwrite,
    session,
    state: 'needs-file',
    loaded: 0,
    total: session.file ? session.file.size : 0,
    note: '',
    error: '',
    xhr: null,
    pauseRequested: false,
    cancelRequested: false,
    dupChecked: true,   // it already passed check-key when it was started
  };
  const done = new Map((session.parts || []).map(p => [p.n, p]));
  task.loaded = bytesDone(done, session);
  tasks.push(task);
  buildTaskRow(task);
  return task;
}

function taskName(task) {
  if (task.file) return task.file.name;
  return (task.session && task.session.file && task.session.file.name) || '(未知文件)';
}

// Where this upload is going, as opposed to what it came from. The two are
// routinely different — a file lands under a minted `uploads/{day}/…` path, and
// an attached upload does not become a file at all — so a row showing only the
// name off the admin's disk cannot answer "which of these is the proxy for the
// concert video".
function taskTarget(task) {
  const spec = attachSpec(task.mode);
  if (!spec) {
    // Exact once /start has answered. Before that it is derivable only when
    // the admin typed one: an empty field is minted server-side, and guessing
    // it here would print a path that is not the one the row gets.
    if (task.session && task.session.path) return task.session.path;
    if (task.path) return task.path.endsWith('/') ? task.path + taskName(task) : task.path;
    return '自动生成';
  }
  if (spec.targetParam === 'announcement_id') {
    // The id is what the server is keyed on, but it is not what the admin
    // recognises. `noticeData` may still be empty on first paint, hence the
    // re-render when the announcement list lands.
    const a = noticeData.find(x => String(x.id) === String(task.target));
    return a ? noticeOptionText(a) : '公告 #' + task.target;
  }
  return task.target;
}

// Every row answers the same question — where is this upload going — so they
// all read 目标. What differs is the *kind* of destination, and that is the
// noun after it: a plain upload gets a 逻辑路径 (`files.path`, which R2 knows
// nothing about), an attach mode gets the object it hangs off. A bare 目标 on
// both would be one word meaning two things one line apart.
function taskTargetText(task) {
  const spec = attachSpec(task.mode);
  if (!spec) return '🎯 逻辑目标路径: ' + taskTarget(task);
  const noun = spec.targetParam === 'announcement_id' ? '目标公告' : '目标文件';
  const label = spec.labelless || !task.label ? '' : ` · ${task.label}`;
  return `🎯 ${noun}: ` + taskTarget(task) + label;
}

// The announcement modes' rows name their target by title, which arrives after
// the first paint. Cheap enough to redraw every row rather than track which.
function refreshTaskTargets() {
  for (const t of tasks) if (t.els) t.els.target.textContent = taskTargetText(t);
}

function startTask(task) {
  setState(task, 'starting');
  runTask(task)
    .catch(err => {
      // runTask handles its own failures; anything reaching here is a bug in
      // this file, and swallowing it silently would strand the slot.
      console.error('Upload task crashed:', err);
      task.error = String(err && err.message || err);
      setState(task, 'failed');
    })
    .finally(() => { task.xhr = null; pump(); });
}

async function runTask(task) {
  const spec = attachSpec(task.mode);

  // 1. Duplicate name check — plain file uploads only. That endpoint tests
  //    `files.path` for collisions, and everything attached deliberately has
  //    no uniqueness on its target (many proxies per file, many attachments
  //    per file, many media per announcement is the point). Running it in an
  //    attach mode would raise the overwrite prompt over an unrelated file,
  //    and overwrite means nothing there. In the announcement mode it would
  //    not even be asking about the right table.
  if (!spec && !task.session && !task.overwrite && !task.dupChecked) {
    setState(task, 'checking');
    task.dupChecked = true;
    const taken = await checkDuplicate(task);
    if (task.cancelRequested) return;
    if (taken) {
      task.dupPath = taken;
      // Waiting for a decision must not hold a slot — the rest of the queue
      // keeps moving while this row asks.
      setState(task, 'awaiting-overwrite');
      return;
    }
  }

  // 2. Open the multipart upload, unless this task already has one. Resume
  //    replays the stored session and never calls /start again: a second start
  //    would mint a second key and orphan everything already sent.
  if (!task.session) {
    setState(task, 'starting');
    const ok = await openUpload(task);
    if (!ok) return;
    // Cancel arriving *while* /start was in flight had nothing to abort when
    // it ran — the session did not exist yet. Without this the upload it just
    // opened would sit in R2 with no row, no task and nothing that knows its
    // upload_id, i.e. a leak only the lifecycle rule ever cleans up.
    if (task.cancelRequested) {
      clearSession(task.session.upload_id);
      await abortSession(task.session);
      return;
    }
  }

  // 3. Transfer, then complete.
  await transfer(task);
}

// Returns the colliding path, or '' for "no collision / could not tell".
async function checkDuplicate(task) {
  try {
    const resp = await fetchWithRetry('/admin/api/files/check-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: task.file.name, path: task.path || undefined }),
    });
    if (!resp.ok) return '';   // the server catches duplicates at /start anyway
    const data = await resp.json();
    return data.exists ? data.path : '';
  } catch (_) {
    return '';
  }
}

async function openUpload(task) {
  const spec = attachSpec(task.mode);
  const file = task.file;
  const contentType = file.type || 'application/octet-stream';
  try {
    const startResp = spec
      ? await fetchWithRetry(spec.startUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Computed key: the target is a file path in three modes and an
            // announcement id in the fourth, and the server reads whichever
            // name its own table is keyed on.
            [spec.targetParam]: task.target,
            filename: file.name,
            content_type: contentType,
            label: task.label,
          }),
        })
      : await fetchWithRetry('/admin/api/upload/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            content_type: contentType,
            path: task.path || undefined,
            overwrite: task.overwrite,
          }),
        });
    if (!startResp.ok) {
      const errData = await startResp.json().catch(() => ({}));
      if (startResp.status === 409 && errData.error === 'duplicate') {
        // Lost the race with another upload (or another tab) between the
        // check and the start. Offer the same decision the check does.
        task.dupPath = errData.path || task.path;
        setState(task, 'awaiting-overwrite');
        return false;
      }
      throw new Error(`创建上传失败: HTTP ${startResp.status}`);
    }
    const startData = await startResp.json();
    // Deliberately no "abort the previous session" step here. The
    // single-session version evicted whatever was stored whenever a new upload
    // started, and aborting it was how it avoided stranding those parts in R2.
    // With a queue that same line would abort every sibling task's multipart
    // upload on each enqueue. Sessions are now independent, and each one is
    // cleaned up by its own task (cancel, discard, or a fatal failure).
    task.session = {
      upload_id: startData.upload_id,
      key: startData.key,       // server-minted; resume replays it, never re-mints
      path: startData.path,
      contentType,
      chunkSize: chunkSizeFor(file.size),
      overwrite: task.overwrite,
      // Read back through `attachSpec(session.mode)`, so a session written
      // before attach modes existed (no `mode`, or `mode: 'file'`) resolves to
      // a plain file upload without a special case.
      mode: task.mode,
      // Legacy field name, read back through `sessionAttachTarget()` — see there.
      attachFilePath: spec ? task.target : undefined,
      attachLabel: spec ? task.label : undefined,
      parts: [],
      file: { name: file.name, size: file.size, lastModified: file.lastModified },
    };
    saveSession(task.session);
    return true;
  } catch (err) {
    console.error('Upload start failed:', err);
    task.error = err.message;
    setState(task, 'failed');
    return false;
  }
}

// Bytes already committed, derived from which part numbers are done. Every
// part is chunkSize except the last, so this is exact — and it makes a
// resumed upload's progress bar start where it left off instead of at 0.
function bytesDone(doneParts, session) {
  let total = 0;
  for (const n of doneParts.keys()) {
    total += Math.min(session.chunkSize, session.file.size - (n - 1) * session.chunkSize);
  }
  return total;
}

// Pause and cancel are delivered by aborting the in-flight XHR, which fires
// the same `error` listener a dropped connection does — status 0, which
// `isRetryable` says to retry. So the task's own intent is checked first,
// everywhere the loop can be interrupted, and throws a control error that
// bypasses both the retry budget and the resumable/fatal branch below.
function throwIfInterrupted(task) {
  if (task.cancelRequested) { const e = new Error('已取消'); e.control = 'cancelled'; throw e; }
  if (task.pauseRequested) { const e = new Error('已暂停'); e.control = 'paused'; throw e; }
}

async function transfer(task) {
  const session = task.session;
  const file = task.file;
  setState(task, 'uploading');

  // Always the session's chunk size, never chunkSizeFor(). R2 requires every
  // part but the last to be identically sized, so raising the constant
  // would silently corrupt any session started under the old one.
  const totalChunks = sessionChunks(session);
  const done = new Map((session.parts || []).map(p => [p.n, p]));
  task.total = file.size;
  setProgress(task, bytesDone(done, session));

  try {
    for (let i = 0; i < totalChunks; i++) {
      const n = i + 1;
      if (done.has(n)) continue; // already committed in an earlier attempt
      throwIfInterrupted(task);

      const start = i * session.chunkSize;
      const chunk = file.slice(start, Math.min(start + session.chunkSize, file.size));
      const base = bytesDone(done, session);

      task.note = `分片 ${n}/${totalChunks}`;
      renderTask(task);
      const part = await uploadChunkWithRetry(task, n, chunk, (chunkLoaded) => {
        setProgress(task, base + chunkLoaded);
      });

      done.set(n, { n: part.part_number, etag: part.etag });
      session.parts = [...done.values()].sort((a, b) => a.n - b.n);
      saveSession(session);
      setProgress(task, bytesDone(done, session));
    }

    throwIfInterrupted(task);
    task.note = '';
    setState(task, 'completing');
    const completeData = await completeUpload(task);

    clearSession(session.upload_id);
    task.loaded = task.total;
    const doneSpec = attachSpec(task.mode);
    // Just the verdict. Where it went is on the row's own target line, which
    // by now holds the path /start actually minted — printing it again here
    // was the same string twice, and for an attached upload it was the *only*
    // place the target appeared, which is what this line no longer has to
    // carry.
    task.note = doneSpec ? doneSpec.okPrefix : '✅ 上传成功!';
    setState(task, 'done');
    scheduleFilesReload();

  } catch (err) {
    if (err.control === 'cancelled') return;   // cancelTask owns the cleanup
    if (err.control === 'paused') {
      task.pauseRequested = false;
      task.note = '';
      saveSession(session);
      setState(task, 'paused');
      return;
    }
    console.error('Upload error:', err);
    task.error = err.message;
    task.note = '';
    if (session.parts.length > 0 && !err.fatal) {
      // Deliberately no abort call. Aborting here is what used to throw
      // away every part already transferred; leaving the multipart upload
      // open is what makes 继续 possible at all. The cost is an orphaned
      // upload in R2 if the admin never comes back — 放弃 cleans it up,
      // and an R2 lifecycle rule is the backstop for the rest.
      saveSession(session);
      setState(task, 'error');
    } else {
      await abortSession(session);
      clearSession(session.upload_id);
      setState(task, 'failed');
    }
  }
}

// Complete is the one step that must never be blindly retried: a success
// whose response was lost leaves the multipart upload consumed, so a second
// attempt errors forever over a file that is already in the bucket.
// Reconcile against the listing before believing the failure.
async function completeUpload(task) {
  const session = task.session;
  try {
    const spec = attachSpec(session.mode);
    const completeResp = spec
      ? await fetch(spec.completeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upload_id: session.upload_id,
            key: session.key,
            [spec.targetParam]: sessionAttachTarget(session),
            label: sessionAttachLabel(session),
            // Ignored by /proxy/complete. An attachment and an announcement's
            // media are downloaded rather than played, and the storage key is
            // opaque, so the display name has to be carried across explicitly.
            filename: session.file.name,
            content_type: session.contentType,
            parts: session.parts,
          }),
        })
      : await fetch(
          `/admin/api/upload/complete?upload_id=${encodeURIComponent(session.upload_id)}&key=${encodePath(session.key)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parts: session.parts,
              content_type: session.contentType,
              path: session.path,
              overwrite: session.overwrite,
            }),
          }
        );
    if (completeResp.status === 409) {
      // Two different dead-session verdicts share this status, and both are
      // fatal — the server has already refused, so 继续 can only loop.
      //   `duplicate`  someone took this name while the session was paused
      //   `file_gone`  the parent file was deleted under an attach upload;
      //                the server aborted the multipart upload on its way out
      // The message must come from the server for `file_gone`: it is the only
      // thing that tells the admin the *file* went away rather than the name
      // being taken, and sending them to re-upload a proxy for a file that no
      // longer exists is a guaranteed second failure.
      const d = await completeResp.json().catch(() => ({}));
      throw uploadError(
        d.error === 'duplicate' || !d.message
          ? `名称 "${d.path || session.path}" 已被其他文件占用，无法完成续传。`
          : d.message,
        409, true);
    }
    if (!completeResp.ok) {
      throw uploadError(await errorMessage(completeResp), completeResp.status);
    }
    return await completeResp.json();
  } catch (err) {
    if (err.fatal) throw err;
    const landed = await uploadLanded(session);
    if (landed) return { path: landed.path, size: landed.size, file_path: landed.path };
    // Genuinely not committed. 继续 can retry this, but only twice — if
    // complete() consumed the upload and the D1 insert then failed, the
    // handler deleted the object and no retry can ever succeed. Bail out
    // rather than leaving the admin in a resume loop.
    session.completeFailures = (session.completeFailures || 0) + 1;
    saveSession(session);
    if (session.completeFailures >= 2) {
      throw uploadError(`无法完成上传（${err.message}）。请放弃并重新上传。`, err.status, true);
    }
    throw err;
  }
}

// ── Task controls ──

// Only from 'queued' and 'uploading'. The states in between — checking,
// starting, completing — are short round trips with nothing to interrupt, and
// honouring a pause in them would leave `pauseRequested` set for a task that
// then goes on to ask about an overwrite, which would throw the moment the
// admin answered.
function canPause(task) { return task.state === 'queued' || task.state === 'uploading'; }

function pauseTask(task) {
  if (!canPause(task)) return;
  if (task.state === 'queued') { setState(task, 'paused'); return; }
  task.pauseRequested = true;
  setState(task, 'pausing');
  abortInFlight(task);
}

function resumeTask(task) {
  if (!task.file) return;             // an adopted session still needs its bytes
  task.pauseRequested = false;
  task.error = '';
  setState(task, 'queued');
  acquireWakeLock('click');           // this click is the gesture WebKit requires
  pump();
}

async function cancelTask(task) {
  task.cancelRequested = true;
  abortInFlight(task);
  const session = task.session;
  setState(task, 'cancelled');
  removeTask(task);
  if (session) {
    clearSession(session.upload_id);
    await abortSession(session);
  }
  pump();
}

function abortInFlight(task) {
  if (!task.xhr) return;
  try { task.xhr.abort(); } catch (_) { /* already settled */ }
}

function removeTask(task) {
  const i = tasks.indexOf(task);
  if (i >= 0) tasks.splice(i, 1);
  if (task.el) task.el.remove();
  syncActivity();
  renderQueueSummary();
}

function clearFinishedTasks() {
  for (const task of [...tasks]) {
    if (task.state === 'done' || task.state === 'failed') removeTask(task);
  }
}

btnClearFinished.addEventListener('click', clearFinishedTasks);

// loadFiles() refreshes the file list, the proxy section and the attach-target
// dropdown. Several tasks finishing within a second of each other would fire
// it several times over; one refresh answers all of them.
let filesReloadTimer = null;
function scheduleFilesReload() {
  clearTimeout(filesReloadTimer);
  filesReloadTimer = setTimeout(() => loadFiles(), 300);
}

// ── Task rows ──

function buildTaskRow(task) {
  const row = document.createElement('div');
  row.className = 'task-row';

  const head = document.createElement('div');
  head.className = 'task-head';
  const name = document.createElement('span');
  name.className = 'task-name';
  name.textContent = taskName(task);          // user-controlled: textContent only
  const badge = document.createElement('span');
  badge.className = 'task-badge';
  const spec = attachSpec(task.mode);
  badge.textContent = spec ? spec.badge : '📄 文件';
  const state = document.createElement('span');
  state.className = 'task-state';
  head.append(name, badge, state);

  // Its own line rather than another chip in the head: a path is as long as a
  // filename, and two long strings on one wrapping row read as one string.
  const target = document.createElement('div');
  target.className = 'task-target';

  const bar = document.createElement('div');
  bar.className = 'upload-progress';
  const fill = document.createElement('div');
  fill.className = 'upload-progress-bar';
  fill.style.width = '0%';
  bar.append(fill);

  const meta = document.createElement('div');
  meta.className = 'task-meta';

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  // Its own picker, deliberately not the form's. The form's input is the
  // enqueue path now, and one file can match two abandoned attempts at the
  // same upload — so "which task did you mean" has to be answered by which
  // row was clicked, not inferred.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const f = picker.files && picker.files[0];
    picker.value = '';
    if (!f) return;
    if (!sessionMatches(task.session, f)) {
      task.error = '所选文件与这个上传不匹配（名称/大小/修改时间需一致）。';
      renderTask(task);
      return;
    }
    task.file = f;
    task.total = f.size;
    task.error = '';
    resumeTask(task);
  });

  row.append(head, target, bar, meta, actions, picker);
  task.el = row;
  task.els = { name, badge, state, target, fill, meta, actions, picker };
  taskListEl.append(row);
  taskListEl.hidden = false;
  renderTask(task);
  renderQueueSummary();
  return row;
}

function setProgress(task, loaded) {
  task.loaded = loaded;
  if (!task.els) return;
  const pct = task.total > 0 ? Math.min(100, Math.round((loaded / task.total) * 100)) : 100;
  task.els.fill.style.width = pct + '%';
  task.els.meta.textContent = metaText(task);
}

function metaText(task) {
  if (task.error) return task.error;
  if (task.state === 'done') return task.note;
  if (task.state === 'awaiting-overwrite') return `已存在: ${task.dupPath}`;
  if (task.state === 'needs-file') return '刷新页面后需要重新选择同一个文件才能继续。';
  const size = `${formatSize(task.loaded)} / ${formatSize(task.total)}`;
  return task.note ? `${size} · ${task.note}` : size;
}

function renderTask(task) {
  if (!task.els) return;
  const { state, fill, meta, actions, target } = task.els;
  task.el.dataset.state = task.state;
  state.textContent = STATE_TEXT[task.state] || task.state;
  // Re-read every render: a file upload's path is only exact once /start has
  // answered, so the row starts on the derived one and settles on the real one.
  target.textContent = taskTargetText(task);
  const pct = task.state === 'done' ? 100
    : (task.total > 0 ? Math.min(100, Math.round((task.loaded / task.total) * 100)) : 0);
  fill.style.width = pct + '%';
  meta.textContent = metaText(task);

  const btns = [];
  const add = (text, cls, fn) => {
    const b = document.createElement('button');
    b.className = cls;
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', fn);
    btns.push(b);
  };

  if (task.state === 'awaiting-overwrite') {
    add('覆盖上传', 'btn-rename-confirm', () => {
      task.overwrite = true;
      task.error = '';
      setState(task, 'queued');
      acquireWakeLock('click');
      pump();
    });
    add('取消', 'btn-rename-cancel', () => cancelTask(task));
  } else if (task.state === 'needs-file') {
    add('📂 选择文件', 'btn-file-action', () => task.els.picker.click());
    add('放弃并清理', 'btn-rename-cancel', () => cancelTask(task));
  } else if (RESUMABLE_STATES.has(task.state)) {
    add('▶ 继续', 'btn-rename-confirm', () => resumeTask(task));
    add('放弃并清理', 'btn-rename-cancel', () => cancelTask(task));
  } else if (task.state === 'done' || task.state === 'failed') {
    add('移除', 'btn-file-action', () => removeTask(task));
  } else if (task.state === 'queued') {
    add('⏸ 暂停', 'btn-file-action', () => pauseTask(task));
    add('取消', 'btn-rename-cancel', () => cancelTask(task));
  } else {
    // checking / starting / uploading / completing / pausing
    const b = document.createElement('button');
    b.className = 'btn-file-action';
    b.type = 'button';
    b.textContent = '⏸ 暂停';
    // Completing has already sent the parts list; interrupting it would leave
    // the multipart upload consumed with nothing recording that it landed.
    // checking/starting are round trips with nothing to interrupt — see canPause.
    b.disabled = !canPause(task);
    b.addEventListener('click', () => pauseTask(task));
    btns.push(b);
    add('取消', 'btn-rename-cancel', () => cancelTask(task));
  }
  actions.replaceChildren(...btns);
}

function renderQueueSummary() {
  const counts = { running: activeCount(), queued: 0, paused: 0, done: 0, failed: 0 };
  for (const t of tasks) {
    if (t.state === 'queued') counts.queued++;
    else if (t.state === 'paused' || t.state === 'error' || t.state === 'needs-file'
      || t.state === 'awaiting-overwrite') counts.paused++;
    else if (t.state === 'done') counts.done++;
    else if (t.state === 'failed') counts.failed++;
  }
  const parts = [];
  if (counts.running) parts.push(`上传中 ${counts.running}`);
  if (counts.queued) parts.push(`排队 ${counts.queued}`);
  if (counts.paused) parts.push(`待处理 ${counts.paused}`);
  if (counts.done) parts.push(`完成 ${counts.done}`);
  if (counts.failed) parts.push(`失败 ${counts.failed}`);
  queueSummaryEl.textContent = parts.length ? parts.join(' · ') : '队列为空';
  taskListEl.hidden = tasks.length === 0;
  btnClearFinished.disabled = !(counts.done || counts.failed);
}

// ── Enqueue ──

// pointerdown is the earliest event carrying transient activation, and it
// fires well before the click handler's own request. Costs nothing when
// that one would have succeeded anyway, and widens the window when it
// wouldn't — the shared in-flight guard means only one request is made.
uploadBtn.addEventListener('pointerdown', () => {
  if (selectedFiles.length) acquireWakeLock('pointerdown');
});

uploadBtn.addEventListener('click', () => {
  if (!selectedFiles.length) return;
  // Ask for the lock here, synchronously in the gesture, and not in any of
  // the async work below — WebKit refuses a request that has outlived its
  // transient activation, and MDN's examples acquire from a click for
  // exactly this reason on every engine.
  acquireWakeLock('click');

  const files = selectedFiles;
  const mode = uploadMode();
  const spec = attachSpec(mode);

  if (spec) {
    const target = attachTargetSelect.value;
    if (!target) { releaseWakeLock(); showResult(false, '❌ 请先选择上传目标。'); return; }
    const label = attachLabelInput.value.trim() || spec.fallbackLabel;
    for (const f of files) enqueue(f, { mode, target, label });
  } else {
    const path = customPath.value.trim();
    // A logical path without a trailing slash is the file's whole path, so N
    // files would all claim it — N-1 guaranteed collisions. With the slash the
    // server treats it as a grouping prefix and appends each filename.
    if (files.length > 1 && path && !path.endsWith('/')) {
      releaseWakeLock();
      showResult(false, '❌ 一次传多个文件时，逻辑目标路径要以 / 结尾（当作分组前缀），或者留空。');
      return;
    }
    for (const f of files) enqueue(f, { mode: 'file', path });
  }

  // The queue owns these uploads now, so the form goes back to being empty
  // and the admin can pick the next batch — in another mode if they like —
  // while these are still transferring.
  clearFormSelection();
  expandUploadSection();
  showResult(true, files.length === 1
    ? `📥 已加入队列: ${files[0].name}`
    : `📥 已加入队列: ${files.length} 个文件`);
  pump();
});

// `fatal` marks a failure that resuming cannot fix, so the catch in
// transfer() aborts and clears instead of offering a 继续 that is
// guaranteed to fail again.
function uploadError(message, status, fatal) {
  const err = new Error(message);
  err.status = status;
  err.fatal = !!fatal;
  return err;
}

// status 0 means the request never got an answer — offline, DNS, a dropped
// connection — which is exactly what a retry is for. 5xx and 429 likewise.
// 4xx are not retried: the per-part Origin check and Access JWT
// verification fail deterministically, so backoff would just burn four
// attempts. An expired admin session lands here as 403 and needs a reload,
// not patience — hence the distinct message below.
function isRetryable(err) {
  const s = err.status;
  // 408 is Cloudflare's edge giving up on a request body that arrived too
  // slowly. It is the single most common failure on a large upload over a
  // modest upstream, it is entirely transient, and leaving it out of this
  // set is what turned every one of them into a manual resume.
  return s === 0 || s === 408 || s === 425 || s === 429 || (s >= 500 && s < 600);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backoff is the wrong wait when the machine is simply offline: a lift, a
// tunnel or a DHCP renew outlasts any schedule worth writing, and retrying
// into a dead interface just burns the budget. Wait for the connection
// instead — capped, because a browser that reports onLine incorrectly must
// not be able to wedge the upload forever.
function waitForOnline(capMs) {
  if (navigator.onLine !== false) return sleep(0);
  return new Promise(resolve => {
    const done = () => {
      window.removeEventListener('online', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, capMs);
    window.addEventListener('online', done);
  });
}

async function uploadChunkWithRetry(task, partNumber, blob, onProgress) {
  const session = task.session;
  let attempt = 0;
  let offlineWaits = 0;
  for (;;) {
    try {
      return await uploadChunk(task, session.upload_id, session.key, partNumber, blob, onProgress);
    } catch (err) {
      // First, before isRetryable: an aborted XHR reports status 0, exactly
      // as a dropped connection does, so without this the retry loop would
      // immediately re-send the part the admin just paused or cancelled.
      throwIfInterrupted(task);
      if (err.status === 401 || err.status === 403) {
        throw uploadError('管理会话已过期，请刷新页面后继续上传。', err.status);
      }
      if (!isRetryable(err)) throw err;
      onProgress(0); // the chunk restarts from zero; un-count the partial send

      // Being offline is a pause, not a failed attempt, so it does not
      // consume the retry budget — a long tunnel costs nothing, while a
      // server that is genuinely broken still gives up on schedule.
      if (navigator.onLine === false && offlineWaits < MAX_OFFLINE_WAITS) {
        offlineWaits++;
        task.note = `📴 分片 ${partNumber} 等待网络恢复…`;
        renderTask(task);
        await waitForOnline(OFFLINE_WAIT_MS);
        throwIfInterrupted(task);
        continue;
      }

      attempt++;
      if (attempt >= PART_RETRIES) throw err;
      task.note = `分片 ${partNumber} 重试 ${attempt}/${PART_RETRIES - 1}…`;
      renderTask(task);
      await sleep(1000 * Math.pow(2, attempt - 1));
      throwIfInterrupted(task);
    }
  }
}

// Retried only where replaying a lost response is cheap. Deliberately NOT
// used for rename or delete: both resolve a row by path, so replaying one
// whose response was lost reports "not found" for work that succeeded —
// turning a success into a spurious error. Those are one click to repeat.
async function fetchWithRetry(url, opts, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const resp = await fetch(url, opts);
      if ((resp.status === 429 || resp.status >= 500) && i < attempts) {
        await sleep(1000 * Math.pow(2, i - 1));
        continue;
      }
      return resp;
    } catch (err) {
      // TypeError — the request never reached anyone.
      if (i >= attempts) throw err;
      await sleep(1000 * Math.pow(2, i - 1));
    }
  }
}

// Did this upload actually land? complete() can succeed server-side with
// the response lost in transit, and the multipart upload is consumed either
// way — so retrying or resuming would fail forever over a file that is
// sitting in the bucket. The storage key is unique per upload, which makes
// the listing decisive where a path check would not be. list_files orders
// uploaded_at DESC inside its 1000-row window, so a row written seconds ago
// is at the front. Returns null for "no" *and* for "couldn't tell".
async function uploadLanded(session) {
  try {
    // An attached upload is never in the file listing — it lives in
    // proxy_videos / file_attachments / announcement_media, keyed by whatever
    // it hangs off. Asking the wrong oracle reports every *successful* attach
    // upload as failed, and complete is the one step that must not be blindly
    // retried: the multipart upload is already consumed, so two reported
    // failures send the admin to 放弃 over an object sitting in the bucket.
    // Hence `spec.targetParam` — a hardcoded `?file_path=` here would query the
    // announcement listing with a param it rejects, i.e. 400 on every reconcile.
    const spec = attachSpec(session.mode);
    if (spec) {
      const filePath = sessionAttachTarget(session);
      const resp = await fetchWithRetry(
        spec.listUrl + '?' + spec.targetParam + '=' + encodeURIComponent(filePath),
        undefined, 2);
      if (!resp.ok) return null;
      const data = await resp.json();
      const hit = (data[spec.listField] || []).find(r => r.key === session.key);
      return hit ? { path: filePath, size: hit.size } : null;
    }
    const resp = await fetchWithRetry('/admin/api/files', undefined, 2);
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.files || []).find(f => f.key === session.key) || null;
  } catch (_) {
    return null;
  }
}

function uploadChunk(task, uploadId, key, partNumber, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Held on the task so pause and cancel can abort it. Cleared on settle so
    // a later abort can never reach a socket that has already closed.
    task.xhr = xhr;
    const settle = () => { if (task.xhr === xhr) task.xhr = null; };

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded);
      }
    });

    xhr.addEventListener('load', () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(uploadError(`分片 ${partNumber}: 响应不是 JSON`, xhr.status));
        }
      } else {
        reject(uploadError(
          `分片 ${partNumber}: HTTP ${xhr.status} — ${(xhr.responseText || '').substring(0, 200)}`,
          xhr.status));
      }
    });

    // status 0 on all three: no response ever arrived. A dropped connection
    // and a timeout are retryable; `abort` is our own pause or cancel, and
    // uploadChunkWithRetry checks the task's intent before the retry test.
    xhr.addEventListener('error', () => { settle(); reject(uploadError(`分片 ${partNumber}: 网络错误`, 0)); });
    xhr.addEventListener('timeout', () => { settle(); reject(uploadError(`分片 ${partNumber}: 超时`, 0)); });
    xhr.addEventListener('abort', () => { settle(); reject(uploadError(`分片 ${partNumber}: 已中止`, 0)); });

    const params = new URLSearchParams({
      upload_id: uploadId,
      key: key,
      n: partNumber,
    });
    xhr.open('PUT', `/admin/api/upload/part?${params}`);
    // Without this a half-dead socket hangs the upload indefinitely. A
    // timeout fires the `timeout` listener above with status 0, which is
    // retryable — the same path a dropped connection takes.
    xhr.timeout = PART_TIMEOUT_MS;
    xhr.send(blob);
  });
}

// Stored sessions are adopted at the *bottom* of this file, not here — a row
// names its target, and an announcement's title comes from `noticeData`,
// which is declared further down. Adopting here would read it inside its
// temporal dead zone and throw before the page had drawn anything.


function showResult(success, msg) {
  uploadResult.hidden = false;
  uploadResult.className = 'upload-result ' + (success ? 'success' : 'error');
  uploadResult.textContent = msg;
}

// Load files
async function loadFiles() {
  try {
    const resp = await fetchWithRetry('/admin/api/files');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    renderFileList(data.files || []);
    // Feed the proxy section from the listing we already have. This used to
    // be a monkey-patch appended further down the script, which never ran for
    // the initial loadFiles() call above it — and it refetched /admin/api/files.
    updateProxySection(data.files || []);
  } catch (err) {
    const li = document.createElement('li');
    li.className = 'file-list-item admin-error';
    li.textContent = '❌ 加载失败: ' + err.message;
    fileListEl.replaceChildren(li);
  }
}

function renderFileList(files) {
  if (files.length === 0) {
    fileListEl.innerHTML = '<li class="file-list-item admin-empty">💤 还没有文件~</li>';
    return;
  }

  // Built with DOM APIs, not string interpolation: keys are user-controlled
  // (filename / custom path) and an inline onclick="...'${key}'..." can be
  // escaped out of with an HTML entity such as &#39;.
  fileListEl.replaceChildren(...files.map(f => {
    // `f.path` is the display name (what rename moves); `f.key` is the
    // immutable R2 object. Older rows have no path — fall back to key.
    const path = f.path || f.key;

    const li = document.createElement('li');
    li.className = 'file-list-item';

    const name = document.createElement('span');
    name.className = 'file-list-name';
    name.title = path;
    name.textContent = '✨ ' + path;

    const size = document.createElement('span');
    size.className = 'file-list-size';
    size.textContent = formatSize(f.size);

    const actions = document.createElement('div');
    actions.className = 'file-list-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-file-action btn-rename';
    renameBtn.textContent = '✏️ 重命名';
    renameBtn.addEventListener('click', () => renameFile(path));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-file-action danger';
    delBtn.textContent = '🗑 删除';
    delBtn.addEventListener('click', () => deleteFile(path, delBtn));

    actions.append(renameBtn);
    // Only playable files can become a proxy — a proxy is a playback source,
    // and the server refuses anything else. Hiding the button on an image is
    // cheaper than explaining the refusal afterwards.
    if (isPlayable(f)) {
      const attachBtn = document.createElement('button');
      attachBtn.className = 'btn-file-action';
      attachBtn.textContent = '🔗 归入';
      attachBtn.title = '把这个文件作为另一个文件的代理';
      attachBtn.addEventListener('click', () => attachFileDialog(f));
      // Only on video and audio: an image is already its own thumbnail, so a
      // cover would be a second picture standing in front of the first.
      const coverBtn = document.createElement('button');
      coverBtn.className = 'btn-file-action';
      coverBtn.textContent = f.cover_key ? '🖼 封面 ✓' : '🖼 封面';
      coverBtn.title = '设置画廊封面';
      coverBtn.addEventListener('click', () => coverDialog(f));
      actions.append(attachBtn, coverBtn);
    }
    actions.append(delBtn);
    // Size and actions share a wrapper so the ≤640 rule can drop the name
    // onto its own line and keep those two together underneath it.
    const meta = document.createElement('div');
    meta.className = 'file-list-meta';
    meta.append(size, actions);
    li.append(name, meta);
    return li;
  }));
}

// Read the server's explanation off a failed response.
// Worker errors come back as a plain-text body, so calling resp.json()
// on them throws a parse error that hides the real cause behind a
// misleading "网络错误".
async function errorMessage(resp) {
  let text = '';
  try {
    text = await resp.text();
  } catch (_) {
    return `HTTP ${resp.status}`;
  }
  try {
    const data = JSON.parse(text);
    if (data && (data.message || data.error)) return data.message || data.error;
  } catch (_) {
    // Not JSON — fall through and show the raw body.
  }
  return text.trim() ? `HTTP ${resp.status}: ${text.trim().slice(0, 300)}` : `HTTP ${resp.status}`;
}

// Deleting a file is never just one row: clips, clip sets, attachments and
// proxies all hang off `files.path`. So this asks the server first and warns
// second — a mode-less DELETE deletes nothing and only reports the impact, and
// the dialog it feeds is the *last* thing the admin sees. One box, naming
// exactly what is about to be lost, and its button is the destructive call.
//
// There is deliberately no `confirm()` anywhere in this flow. There used to be
// one before the request, back when a mode-less DELETE destroyed an unattached
// file — the impact was only known from the refusal, which arrived too late to
// gate that call. It is safe to drop precisely because that call no longer
// destroys anything; and a native confirm that says less than the dialog behind
// it is not a safeguard, it is the second box the admin was complaining about.
async function deleteFile(path, btn) {
  // The probe is a round trip where an unattached file used to get an instant
  // native dialog, so the button says so — otherwise a slow answer reads as a
  // dead click and the second click fires a second probe.
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ...'; }
  let plan;
  try {
    const resp = await fetch(`/admin/api/files/${encodePath(path)}`, { method: 'DELETE' });
    // 409 is the only expected answer: the query never succeeds, because it
    // never does anything. A 200 here would mean the server deleted the file
    // without being told which way — refresh and say so rather than pretend.
    if (resp.ok) { alert('服务器直接删除了该文件（未经确认）。'); loadFiles(); return; }
    if (resp.status !== 409) { alert('删除失败: ' + await errorMessage(resp)); return; }
    plan = await resp.json();
    if (plan.error !== 'confirm_required') { alert('删除失败: ' + (plan.message || '')); return; }
  } catch (err) {
    alert('网络错误: ' + err.message);
    return;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
  showDeletePlan(path, plan);
}

function showDeletePlan(path, plan) {
  const proxies = Array.isArray(plan.proxies) ? plan.proxies : [];
  const overlay = document.createElement('div');
  overlay.className = 'rename-dialog-overlay';
  overlay.innerHTML = `
    <div class="rename-dialog delete-dialog">
      <h3>🗑 删除文件</h3>
      <div class="rename-oldpath"></div>
      <div class="delete-impact"></div>
      <div class="delete-promote" hidden>
        <label class="rename-label" for="promote-select">保留切片：用哪个代理接替原片</label>
        <select id="promote-select"></select>
        <div class="rename-hint" id="promote-hint"></div>
      </div>
      <div class="rename-dialog-actions">
        <button class="btn-rename-cancel">取消</button>
        <button class="btn-delete-purge">全部删除</button>
        <button class="btn-rename-confirm btn-delete-promote" hidden>用代理替换原片</button>
      </div>
    </div>
  `;
  // Paths, labels and keys are user-controlled — every one of them goes in via
  // textContent / option.value, never interpolated into the markup above.
  overlay.querySelector('.rename-oldpath').textContent = path;

  const impact = overlay.querySelector('.delete-impact');
  const promoteBox = overlay.querySelector('.delete-promote');
  const promoteBtn = overlay.querySelector('.btn-delete-promote');
  const purgeBtn = overlay.querySelector('.btn-delete-purge');
  const select = overlay.querySelector('#promote-select');
  const hint = overlay.querySelector('#promote-hint');

  const lost = [];
  if (plan.clips) lost.push(`${plan.clips} 个切片`);
  if (plan.clip_sets) lost.push(`${plan.clip_sets} 个切片合集`);
  if (plan.attachments) lost.push(`${plan.attachments} 个关联文件`);
  if (proxies.length) lost.push(`${proxies.length} 个代理`);

  const line = document.createElement('p');
  line.textContent = lost.length
    ? '该文件关联了 ' + lost.join('、') + '。'
    : '该文件没有关联内容。';
  impact.appendChild(line);

  // 全部删除 is the wrong promise when there is nothing else to delete — this
  // dialog now stands alone, so its button has to say exactly what it does.
  if (!lost.length) purgeBtn.textContent = '删除文件';

  if (proxies.length) {
    // Biggest-with-a-picture is the server's suggestion and it is preselected,
    // so the default needs no interaction — but it is named in full, because
    // which copy becomes the master is not a detail the admin should discover
    // afterwards from a shrunken file size.
    proxies.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.key;
      const audio = (p.content_type || '').startsWith('audio/');
      opt.textContent = `${p.label || '(无标签)'} — ${formatSize(p.size)}${audio ? ' · 纯音频' : ''}`;
      if (p.key === plan.suggested_key) opt.selected = true;
      select.appendChild(opt);
    });
    const describe = () => {
      const p = proxies.find((x) => x.key === select.value);
      const audio = p && (p.content_type || '').startsWith('audio/');
      hint.textContent = audio
        ? '⚠️ 这是纯音频代理。替换后该文件在画廊里会变成音频，切片将没有画面。'
        : '原片将被删除以释放空间，切片、合集和关联文件全部保留 —— 代理与原片时间轴一致，所有时间点依然有效。';
    };
    select.addEventListener('change', describe);
    describe();
    promoteBox.hidden = false;
    promoteBtn.hidden = false;
  } else {
    const warn = document.createElement('p');
    warn.className = 'delete-warn';
    warn.textContent = lost.length
      ? '没有代理可以接替原片，以上内容将一并永久删除，无法恢复。'
      : '删除后无法恢复。';
    impact.appendChild(warn);
  }

  document.body.appendChild(overlay);

  const cancelBtn = overlay.querySelector('.btn-rename-cancel');
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };

  // Escape closes, and that is the whole keyboard surface. The rename dialog
  // binds Enter to its confirm button; the equivalent here purges a file and
  // everything hanging off it, so a stray Enter must do nothing. Focus starts
  // on 取消 for the same reason — this dialog is the only gate there is.
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  cancelBtn.focus();

  async function send(query, busyLabel, btn) {
    const original = btn.textContent;
    purgeBtn.disabled = promoteBtn.disabled = true;
    btn.textContent = busyLabel;
    try {
      const resp = await fetch(`/admin/api/files/${encodePath(path)}?${query}`, { method: 'DELETE' });
      if (resp.ok) {
        const d = await resp.json().catch(() => ({}));
        close();
        // Promotion is announced, purge is not. `showResult` writes into the
        // upload panel, which is usually scrolled away from the file list, and
        // the file surviving at a new size is surprising enough that the admin
        // has to be told which copy became the master. A purge needs no notice:
        // the row disappearing from the refreshed list is the confirmation.
        if (d.promoted) {
          alert(`已用代理「${d.label || '(无标签)'}」替换原片 (${formatSize(d.size)})。\n切片、合集和关联文件全部保留。`);
        }
        loadFiles();
        return;
      }
      alert('操作失败: ' + await errorMessage(resp));
    } catch (err) {
      alert('网络错误: ' + err.message);
    }
    purgeBtn.disabled = promoteBtn.disabled = false;
    btn.textContent = original;
  }

  promoteBtn.addEventListener('click', () =>
    send('mode=promote&promote_key=' + encodeURIComponent(select.value), '⏳ ...', promoteBtn));
  purgeBtn.addEventListener('click', () => send('mode=purge', '⏳ ...', purgeBtn));
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// ── Collections: fold a file in as a proxy, or lift one back out ──
//
// A collection is not a table — it is a `files` row plus the proxies and
// related files naming its path. So both directions are pure D1 row moves and
// return instantly whatever the file weighs; nothing here uploads or copies.
// This dialog is the "gather what I already uploaded" half; the "add by
// uploading" half is the 📹 代理 mode of the upload section.
function attachFileDialog(file) {
  const source = file.path || file.key;
  const targets = proxyFileData.filter(f => (f.path || f.key) !== source);
  // Its ids are `groupinto-*`, not `attach-*`: the upload section already owns
  // `#attach-target` / `#attach-label`, and a duplicate id points this dialog's
  // `<label for=>` at the element behind the overlay.

  const overlay = document.createElement('div');
  overlay.className = 'rename-dialog-overlay';
  overlay.innerHTML = `
    <div class="rename-dialog delete-dialog">
      <h3>🔗 归入合集</h3>
      <div class="rename-oldpath"></div>
      <label class="rename-label" for="groupinto-target">作为哪个文件的代理</label>
      <select id="groupinto-target"></select>
      <label class="rename-label attach-label-row" for="groupinto-label">标签</label>
      <input type="text" id="groupinto-label" maxlength="32">
      <div class="rename-hint">该文件将从列表中消失，成为目标文件的一个播放源。不移动任何数据，随时可以「⤴ 独立」还原。</div>
      <div class="rename-dialog-actions">
        <button class="btn-rename-cancel">取消</button>
        <button class="btn-rename-confirm btn-groupinto-confirm">归入</button>
      </div>
    </div>
  `;
  overlay.querySelector('.rename-oldpath').textContent = source;
  const select = overlay.querySelector('#groupinto-target');
  // `new Option`, not innerHTML — paths are user-controlled.
  if (targets.length) {
    select.replaceChildren(...targets.map(f => new Option(
      `${f.path || f.key} (${formatSize(f.size)})`, f.path || f.key)));
  } else {
    select.replaceChildren(new Option('（没有其他视频/音频文件）', ''));
  }
  const labelInput = overlay.querySelector('#groupinto-label');
  labelInput.value = (source.split('/').pop() || source).slice(0, 32);
  document.body.appendChild(overlay);

  const confirmBtn = overlay.querySelector('.btn-groupinto-confirm');
  const cancelBtn = overlay.querySelector('.btn-rename-cancel');
  confirmBtn.disabled = !targets.length;
  const close = () => overlay.remove();

  confirmBtn.addEventListener('click', async () => {
    if (!select.value) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ ...';
    try {
      const resp = await fetch('/admin/api/files/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_path: source,
          target_path: select.value,
          label: labelInput.value.trim(),
        }),
      });
      if (resp.ok) { close(); loadFiles(); return; }
      // 409 `source_not_empty` is the one worth spelling out: the source has
      // clips or related files of its own, which would be orphaned when its
      // `files` row goes. The server's message says so; the counts say how much.
      const d = await resp.json().catch(() => ({}));
      if (d.error === 'source_not_empty') {
        const bits = [];
        if (d.clips) bits.push(`${d.clips} 个切片`);
        if (d.clip_sets) bits.push(`${d.clip_sets} 个合集`);
        if (d.attachments) bits.push(`${d.attachments} 个关联文件`);
        if (d.proxies) bits.push(`${d.proxies} 个代理`);
        alert(`无法归入：该文件自己有 ${bits.join('、')}，归入后会失去归属。\n请先处理它们。`);
      } else {
        alert('归入失败: ' + (d.message || d.error || resp.status));
      }
    } catch (err) {
      alert('网络错误: ' + err.message);
    }
    confirmBtn.disabled = false;
    confirmBtn.textContent = '归入';
  });
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

async function detachProxy(proxy, onDone) {
  const fallback = (proxy.key.split('/').pop() || 'proxy');
  const path = prompt('还原为独立文件，新文件名：', fallback);
  if (path === null) return;
  try {
    const resp = await fetch('/admin/api/proxy/detach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: proxy.key, path: path.trim() }),
    });
    if (resp.ok) { onDone(); loadFiles(); return; }
    alert('还原失败: ' + await errorMessage(resp));
  } catch (err) {
    alert('网络错误: ' + err.message);
  }
}

// ── Rename ──
// Takes the display path. Since migration 0002 this is a D1-only update —
// no R2 copy — so it returns immediately whatever the file's size.
function renameFile(oldPath) {
  // Extract just the filename portion for the default value
  const filename = oldPath.split('/').pop() || oldPath;

  // Build a simple modal
  const overlay = document.createElement('div');
  overlay.className = 'rename-dialog-overlay';
  // No path interpolation into markup — `oldPath`/`filename` go in via
  // textContent/.value so an HTML entity in the name can't break out.
  overlay.innerHTML = `
    <div class="rename-dialog">
      <h3>✏️ 重命名文件</h3>
      <div class="rename-oldpath"></div>
      <label class="rename-label" for="rename-input">新名称</label>
      <input type="text" id="rename-input" autofocus>
      <div class="rename-hint">改的是逻辑目标路径的最后一段，前面的分组前缀保留；连 / 一起输入可以换到别的分组。存储键不变，文件本身不会被搬动。</div>
      <div class="rename-dialog-actions">
        <button class="btn-rename-cancel">取消</button>
        <button class="btn-rename-confirm">确认重命名</button>
      </div>
    </div>
  `;
  overlay.querySelector('.rename-oldpath').textContent = '原逻辑目标路径: ' + oldPath;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#rename-input');
  input.value = filename;
  const confirmBtn = overlay.querySelector('.btn-rename-confirm');
  const cancelBtn = overlay.querySelector('.btn-rename-cancel');

  // Focus and select the name part (without extension)
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx > 0) {
    input.setSelectionRange(0, dotIdx);
  } else {
    input.select();
  }

  async function doRename() {
    const newName = input.value.trim();
    if (!newName) { alert('名称不能为空'); return; }
    if (newName === filename) { closeDialog(); return; }

    // Build new path: replace the last segment (filename) with new name
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ ...';

    try {
      const resp = await fetch('/admin/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
      });
      if (resp.ok) {
        closeDialog();
        loadFiles();
      } else {
        alert('重命名失败: ' + await errorMessage(resp));
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认重命名';
      }
    } catch (err) {
      alert('网络错误: ' + err.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = '确认重命名';
    }
  }

  function closeDialog() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter') doRename();
  }

  confirmBtn.addEventListener('click', doRename);
  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  document.addEventListener('keydown', onKey);
  input.focus();
}

function encodePath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}


// ── Proxy management ──
const proxyList = document.getElementById('proxy-list');
let proxyFileData = []; // { file_path, key } from the file listing

// Initial load. It has to come *after* the `const`s above: loadFiles now
// calls updateProxySection, which reads proxyList, and a const is in its
// temporal dead zone until this line of the script has run.
loadFiles();

// A proxy is a playback source, so both ends of an attach have to be one. Same
// predicate the proxy section uses to decide which files can carry proxies at
// all, and the same rule the server enforces.
function isPlayable(f) {
  const ct = f.content_type || '';
  return ct.startsWith('video/') || ct.startsWith('audio/');
}

function updateProxySection(files) {
  proxyFileData = files.filter(isPlayable);
  renderAttachTargets();
  if (proxyFileData.length === 0) {
    proxyList.replaceChildren(mkNote('admin-empty', '没有可代理的视频/音频文件。'));
    return;
  }
  renderProxyRows();
}

// Feeds the target dropdown shared by 代理 and 关联文件 from the listing that
// is already in hand — no extra request. Keeps the current selection across a
// refresh so uploading does not reset the target you just used.
function renderAttachTargets() {
  const previous = attachTargetSelect.value;
  // One select, two populations, picked by mode: 代理 and 关联文件 attach to a
  // file, 公告附件 attaches to an announcement. Refilled on every mode change
  // (applyUploadMode calls this) — leaving a file path selected while the
  // announcement mode is active would post it as an `announcement_id`.
  const forAnnouncement = uploadMode() === 'announcement';
  // Built with `new Option`, not innerHTML: paths and titles are user-typed.
  const opts = forAnnouncement
    ? noticeData.map(a => new Option(noticeOptionText(a), String(a.id)))
    : proxyFileData.map(f => new Option(f.path || f.key, f.path || f.key));
  const stillThere = forAnnouncement
    ? noticeData.some(a => String(a.id) === previous)
    : proxyFileData.some(f => (f.path || f.key) === previous);

  if (!opts.length) {
    attachTargetSelect.replaceChildren(new Option(forAnnouncement
      ? '（还没有公告，请先在「📢 公告」区新建）'
      : '（没有可关联的视频/音频文件）', ''));
  } else {
    attachTargetSelect.replaceChildren(...opts);
    if (previous && stillThere) attachTargetSelect.value = previous;
  }
  refreshUploadButton();
}

// An announcement's title is optional, so the option text falls back to the
// first line of the body and then to the id — a dropdown of blank rows is
// unusable, and the id is the one thing that always exists.
function noticeOptionText(a) {
  const head = (a.title || a.body || '').split('\n')[0].trim();
  const shown = head.length > 40 ? head.slice(0, 40) + '…' : head;
  return (a.is_published ? '' : '[草稿] ') + (shown || '(无标题)') + ' #' + a.id;
}

// ── Covers ──
//
// Two ways in, because they are genuinely different acts: uploading a new image
// is an upload (so it belongs to the upload section, with resume and progress),
// while picking one of the file's existing attachments is a single D1 write and
// belongs here, next to the file it changes.
async function coverDialog(file) {
  const path = file.path || file.key;
  const overlay = document.createElement('div');
  overlay.className = 'rename-dialog-overlay';
  const box = document.createElement('div');
  box.className = 'rename-dialog cover-dialog';

  const title = document.createElement('h3');
  title.textContent = '🖼 封面';
  const sub = document.createElement('p');
  sub.className = 'admin-note';
  sub.textContent = path;

  const current = document.createElement('div');
  current.className = 'cover-current';
  current.textContent = '加载中...';

  const pickWrap = document.createElement('div');
  pickWrap.className = 'cover-picks';

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const clear = document.createElement('button');
  clear.className = 'btn-file-action danger';
  clear.textContent = '清除封面';
  const close = document.createElement('button');
  close.className = 'btn-rename-cancel';
  close.textContent = '关闭';
  actions.append(clear, close);

  box.append(title, sub, current, pickWrap, actions);
  overlay.append(box);
  document.body.append(overlay);

  const shut = () => overlay.remove();
  close.addEventListener('click', shut);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) shut(); });

  const setCover = async (key) => {
    const resp = await fetch('/admin/api/files/cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, key: key || '' }),
    });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) { alert('设置失败: ' + (d.message || resp.status)); return; }
    shut();
    loadFiles();
  };
  clear.addEventListener('click', () => setCover(''));

  // Both lists come from routes that already exist; nothing here is a new shape.
  let cover = null, attachments = [];
  try {
    const [c, a] = await Promise.all([
      fetch('/admin/api/cover?file_path=' + encodeURIComponent(path)).then(r => r.json()),
      fetch('/admin/api/attachment?file_path=' + encodeURIComponent(path)).then(r => r.json()),
    ]);
    cover = (c.covers || [])[0] || null;
    attachments = a.attachments || [];
  } catch (err) {
    current.textContent = '❌ 加载失败: ' + err.message;
    return;
  }

  current.replaceChildren();
  if (cover) {
    const img = document.createElement('img');
    img.className = 'cover-thumb';
    img.src = '/api/file/' + encodePath(cover.key);
    img.alt = '当前封面';
    const cap = document.createElement('div');
    cap.className = 'admin-row-sub';
    cap.textContent = '当前封面';
    current.append(img, cap);
  } else {
    current.append(mkNote('admin-empty', '还没有封面。'));
  }

  // Attachments are stored as application/octet-stream whatever they are (the
  // serve path re-clamps anything non-media), so the *stored* type cannot say
  // which ones are images — the filename is the only hint available, and a
  // wrong guess costs nothing: the preview simply fails to load and the admin
  // picks another.
  const images = attachments.filter(a => /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(a.filename || ''));
  const hint = document.createElement('div');
  hint.className = 'form-hint';
  hint.textContent = images.length
    ? '也可以直接选用该文件的关联图片（不会复制文件）：'
    : '要上传新封面，请用上方「🖼 封面」模式。该文件没有可用的关联图片。';
  pickWrap.append(hint);

  for (const a of images) {
    const btn = document.createElement('button');
    btn.className = 'cover-pick' + (cover && cover.key === a.key ? ' active' : '');
    btn.title = a.filename;
    const img = document.createElement('img');
    img.src = '/api/file/' + encodePath(a.key);
    img.alt = a.filename || '';
    img.loading = 'lazy';
    const cap = document.createElement('span');
    cap.textContent = a.label || a.filename;
    btn.append(img, cap);
    btn.addEventListener('click', () => setCover(a.key));
    pickWrap.append(btn);
  }
}

// All three lists are the same shape — label · size, delete, keyed off the one
// thing they hang from — so one renderer serves them, driven by the same
// ATTACH_SPECS the uploader uses. `noun` and `icon` are the only per-kind UI
// text; `spec.targetParam` is what makes "the one thing" a file path here and
// an announcement id there.
const ATTACH_VIEWS = {
  // `detachable` only on proxies: an attachment is a download bound to a file
  // (subtitles for *that* video), not an encode of it, so there is no standalone
  // file for it to become. Announcement media likewise.
  proxy: {
    spec: ATTACH_SPECS.proxy, icon: '📹', noun: '代理', detachable: true,
    addHint: '在上方「📹 代理」模式中添加，或在文件列表用「🔗 归入」把已上传的文件收进来。',
  },
  attachment: {
    spec: ATTACH_SPECS.attachment, icon: '📎', noun: '关联文件',
    addHint: '在上方「📎 关联文件」模式中添加。',
  },
  announcement: {
    spec: ATTACH_SPECS.announcement, icon: '📎', noun: '附件',
    addHint: '在上方「📢 公告附件」模式中添加。',
  },
};

// Fetched per target, on demand. Eagerly counting them fired one admin request
// per video on every listing refresh — /admin/api/files returns up to 1000 rows.
//
// `target` is the token the list is keyed on (a display path, or an
// announcement id), resolved by the caller — this function never reaches into a
// record to find it, because the three callers hold three different shapes.
async function toggleAttachDetail(view, target, panel, btn) {
  if (!panel.hidden) { panel.hidden = true; btn.textContent = view.icon + ' ' + view.noun; return; }
  panel.hidden = false;
  btn.textContent = view.icon + ' 收起';
  panel.textContent = '加载中...';
  try {
    const resp = await fetch(
      view.spec.listUrl + '?' + view.spec.targetParam + '=' + encodeURIComponent(target));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = (await resp.json())[view.spec.listField] || [];
    renderAttachDetail(view, target, panel, btn, rows);
  } catch (err) {
    panel.textContent = '❌ 加载失败: ' + err.message;
  }
}

function renderAttachDetail(view, target, panel, btn, records) {
  const rows = records.map(p => {
    const line = document.createElement('div');
    line.className = 'admin-subrow';
    const label = document.createElement('span');
    label.className = 'admin-row-name';
    // An attachment's own filename is what a viewer downloads, so show it
    // alongside the admin's label — the label alone ("中文字幕") does not say
    // whether the file that landed is the .srt or the .ass.
    const parts = [p.label || view.noun];
    if (p.filename) parts.push(p.filename);
    parts.push(formatSize(p.size));
    label.textContent = parts.join(' · ');
    label.title = p.key;
    const del = document.createElement('button');
    del.className = 'btn-file-action danger';
    del.textContent = '🗑';
    del.title = '删除该' + view.noun;
    del.addEventListener('click', async () => {
      if (!confirm('确认删除' + view.noun + ' "' + (p.label || p.filename || p.key) + '"？')) return;
      const resp = await fetch(view.spec.listUrl + '?key=' + encodeURIComponent(p.key), { method: 'DELETE' });
      if (resp.ok) {
        panel.hidden = true;
        btn.textContent = view.icon + ' ' + view.noun;
        toggleAttachDetail(view, target, panel, btn);
      } else alert('删除失败');
    });
    if (view.detachable) {
      const out = document.createElement('button');
      out.className = 'btn-file-action';
      out.textContent = '⤴ 独立';
      out.title = '还原为独立文件（不移动数据）';
      out.addEventListener('click', () => detachProxy(p, () => {
        panel.hidden = true;
        btn.textContent = view.icon + ' ' + view.noun;
        toggleAttachDetail(view, target, panel, btn);
      }));
      line.append(label, out, del);
    } else {
      line.append(label, del);
    }
    return line;
  });

  // No upload button here — uploading is a mode of the main upload section,
  // which brings resume, the progress bar and the wake lock with it.
  if (!rows.length) {
    const empty = document.createElement('span');
    empty.className = 'admin-empty';
    empty.textContent = '暂无' + view.noun + '。' + view.addHint;
    panel.replaceChildren(empty);
  } else {
    panel.replaceChildren(...rows);
  }
}

function renderProxyRows() {
  proxyList.replaceChildren(...proxyFileData.map(f => {
    const path = f.path || f.key;
    const name = path.split('/').pop() || path;
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'admin-row';
    const nm = document.createElement('span');
    nm.className = 'admin-row-name';
    nm.textContent = '🎬 ' + name;
    nm.title = path;
    row.append(nm);
    // One panel per kind, so opening 关联文件 does not collapse 代理.
    for (const view of [ATTACH_VIEWS.proxy, ATTACH_VIEWS.attachment]) {
      const panel = document.createElement('div');
      panel.hidden = true;
      panel.className = 'admin-subpanel';
      const btn = document.createElement('button');
      btn.className = 'btn-file-action';
      btn.textContent = view.icon + ' ' + view.noun;
      btn.addEventListener('click', () => toggleAttachDetail(view, path, panel, btn));
      row.append(btn);
      wrap.append(panel);
    }
    wrap.prepend(row);
    return wrap;
  }));
}

// ── Clip management ──
$('btn-load-clips').addEventListener('click', loadAdminClips);
async function loadAdminClips() {
  $('btn-load-clips').disabled = true;
  $('btn-load-clips').textContent = '⏳ ...';
  try {
    const resp = await fetch('/admin/api/clips?limit=500');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    $('clip-admin-count').textContent = '共 ' + (data.clips || []).length + ' 个切片';
    renderAdminClips(data.clips || []);
  } catch (err) {
    $('clip-admin-list').replaceChildren(mkNote('admin-error', '❌ 加载失败: ' + err.message));
  } finally {
    $('btn-load-clips').disabled = false;
    $('btn-load-clips').textContent = '🔄 加载切片';
  }
}

function renderAdminClips(clips) {
  if (!clips.length) {
    $('clip-admin-list').replaceChildren(mkNote('admin-empty', '暂无切片。'));
    return;
  }
  $('clip-admin-list').replaceChildren(...clips.map(c => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    // Clip names and nicknames are user-controlled. This used to be an
    // innerHTML string with a hand-rolled `<` escape, which leaves quotes
    // and entities intact; DOM APIs are the rule everywhere else here.
    const info = document.createElement('span');
    info.className = 'admin-row-info';
    const nm = document.createElement('b'); nm.textContent = c.name || '未命名';
    const by = document.createTextNode(' by ' + (c.nickname || '匿名') + ' ');
    const tm = document.createElement('span');
    tm.className = 'admin-row-sub';
    tm.textContent = formatTime2(c.start_time) + '–' + formatTime2(c.end_time);
    info.append(nm, by, tm, document.createTextNode(' ❤️' + (c.like_count || 0)));
    const acts = document.createElement('div');
    acts.className = 'admin-row-actions';

    const featBtn = document.createElement('button');
    featBtn.className = 'btn-file-action';
    featBtn.textContent = c.is_featured ? '⭐ 取消精选' : '☆ 精选';
    featBtn.addEventListener('click', async () => {
      const resp = await fetch('/admin/api/clips/' + encodeURIComponent(c.id) + '/feature', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featured: !c.is_featured }),
      });
      if (resp.ok) loadAdminClips(); else alert('操作失败');
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-file-action danger';
    delBtn.textContent = '🗑 删除';
    delBtn.addEventListener('click', async () => {
      if (!confirm('确认删除切片 "'+(c.name||'未命名')+'"？')) return;
      const resp = await fetch('/admin/api/clips/' + encodeURIComponent(c.id), { method: 'DELETE' });
      if (resp.ok) loadAdminClips(); else alert('删除失败');
    });

    acts.append(featBtn, delBtn);
    row.append(info, acts);
    return row;
  }));
}

$('btn-load-clip-sets').addEventListener('click', loadClipSets);
async function loadClipSets() {
  const btn = $('btn-load-clip-sets');
  btn.disabled = true; btn.textContent = '⏳ ...';
  try {
    const resp = await fetch('/admin/api/clip-sets?limit=500');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const sets = data.sets || [];
    $('clip-set-count').textContent = '共 ' + sets.length + ' 个归档';
    renderClipSets(sets);
  } catch (err) {
    $('clip-set-list').replaceChildren(mkNote('admin-error', '❌ 加载失败: ' + err.message));
  } finally {
    btn.disabled = false; btn.textContent = '🔄 加载归档';
  }
}

function renderClipSets(sets) {
  if (!sets.length) {
    $('clip-set-list').replaceChildren(mkNote('admin-empty', '暂无归档。'));
    return;
  }
  $('clip-set-list').replaceChildren(...sets.map(s => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    // Set names and nicknames are user-controlled — build with DOM APIs, never innerHTML.
    const info = document.createElement('span');
    info.className = 'admin-row-info';
    const nm = document.createElement('b'); nm.textContent = s.name || '未命名归档';
    const rest = document.createElement('span');
    rest.textContent = ' by ' + (s.nickname || '匿名') + ' · ' + (s.clip_count || 0) + ' 个公开切片 · ❤️' + (s.like_count || 0) + ' · ' + (s.file_path || '');
    info.append(nm, rest);

    const acts = document.createElement('div');
    acts.className = 'admin-row-actions';
    const idBtn = document.createElement('button');
    idBtn.className = 'btn-file-action';
    idBtn.textContent = '📋 复制作者标识';
    idBtn.title = s.identity || '';
    idBtn.addEventListener('click', () => {
      // Feeds the batch-delete box below, which takes an identity string.
      navigator.clipboard.writeText(s.identity || '').then(
        () => { idBtn.textContent = '✅ 已复制'; setTimeout(() => { idBtn.textContent = '📋 复制作者标识'; }, 2000); },
        () => alert('复制失败: ' + (s.identity || '')));
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-file-action danger';
    delBtn.textContent = '🗑 删除归档';
    delBtn.addEventListener('click', async () => {
      if (!confirm('确认删除归档 "' + (s.name||'未命名') + '"？其中的 ' + (s.clip_count||0) + ' 个切片也会一并删除。')) return;
      const resp = await fetch('/admin/api/clip-sets/' + encodeURIComponent(s.id), { method: 'DELETE' });
      if (resp.ok) { loadClipSets(); loadAdminClips(); } else alert('删除失败');
    });

    acts.append(idBtn, delBtn);
    row.append(info, acts);
    return row;
  }));
}

function formatTime2(s) {
  if (s == null || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// ── Report management ──
$('btn-load-reports').addEventListener('click', loadReports);
async function loadReports() {
  $('btn-load-reports').disabled = true;
  $('btn-load-reports').textContent = '⏳ ...';
  try {
    const resp = await fetch('/admin/api/clips/reports');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    renderReports(data.reports || []);
  } catch (err) {
    $('report-list').replaceChildren(mkNote('admin-error', '❌ 加载失败: ' + err.message));
  } finally {
    $('btn-load-reports').disabled = false;
    $('btn-load-reports').textContent = '🔄 加载举报';
  }
}

function renderReports(reports) {
  if (!reports.length) {
    $('report-list').replaceChildren(mkNote('admin-empty', '暂无未处理的举报 🎉'));
    return;
  }
  $('report-list').replaceChildren(...reports.map(r => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    // The report reason is free text typed by a stranger — the old
    // innerHTML escaped `<` only, which is not enough on its own.
    const info = document.createElement('div');
    info.className = 'admin-row-info';
    const l1 = document.createElement('div');
    l1.append(mkLabel('切片: '), document.createTextNode(r.clip_id || ''));
    const l2 = document.createElement('div');
    l2.className = 'admin-row-sub';
    l2.append(mkLabel('举报者: '), document.createTextNode(r.identity || ''),
              mkLabel(' 原因: '), document.createTextNode(r.reason || '(无)'));
    const l3 = document.createElement('div');
    l3.className = 'admin-row-sub';
    l3.textContent = r.created_at || '';
    info.append(l1, l2, l3);
    const acts = document.createElement('div');
    acts.className = 'admin-row-actions';
    const resBtn = document.createElement('button');
    resBtn.className = 'btn-file-action btn-rename';
    resBtn.textContent = '✅ 处理';
    resBtn.addEventListener('click', async () => {
      const resp = await fetch('/admin/api/clips/reports/' + r.id + '/resolve', { method: 'POST' });
      if (resp.ok) loadReports(); else alert('操作失败');
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-file-action danger';
    delBtn.textContent = '🗑 删除切片';
    delBtn.addEventListener('click', async () => {
      if (!confirm('确认删除切片 ' + r.clip_id + '？')) return;
      const resp = await fetch('/admin/api/clips/' + encodeURIComponent(r.clip_id), { method: 'DELETE' });
      if (resp.ok) { loadReports(); loadAdminClips(); } else alert('删除失败');
    });
    acts.append(resBtn, delBtn);
    row.append(info, acts);
    return row;
  }));
}

// ── Batch delete ──
$('btn-batch-delete').addEventListener('click', async () => {
  const id = $('batch-identity').value.trim();
  if (!id) { alert('请输入用户标识符。'); return; }
  if (!confirm('确认删除该用户 (' + id + ') 的所有切片和点赞？此操作不可撤销。')) return;
  try {
    const resp = await fetch('/admin/api/identity/' + encodeURIComponent(id) + '/clips', { method: 'DELETE' });
    const data = await resp.json();
    $('batch-result').hidden = false;
    $('batch-result').className = 'admin-result ' + (resp.ok ? 'ok' : 'err');
    $('batch-result').textContent = resp.ok
      ? '✅ 已删除 ' + data.deleted + ' 个切片。'
      : '❌ 删除失败: ' + (data.error || resp.status);
  } catch (err) {
    $('batch-result').hidden = false;
    $('batch-result').className = 'admin-result err';
    $('batch-result').textContent = '❌ 网络错误: ' + err.message;
  }
});

// ── Announcements ──
//
// Create is deliberately its own step rather than one save that also uploads:
// media hangs off an announcement id, so the row has to exist first. 立即发布
// unchecked is what makes that sequence safe — write it, attach the poster,
// then publish — which is why the flags are on the editor and not only on the
// rows.
let noticeData = [];
let noticeEditingId = null;

$('btn-load-notices').addEventListener('click', loadNotices);

async function loadNotices() {
  const btn = $('btn-load-notices');
  btn.disabled = true;
  btn.textContent = '⏳ ...';
  try {
    const resp = await fetch('/admin/api/announcements');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    noticeData = data.announcements || [];
    renderNotices();
    // The upload section's target dropdown is fed from this same array, so an
    // announcement created a moment ago is uploadable without a page reload.
    renderAttachTargets();
    // Queue rows in the announcement mode name their target by title, which
    // only exists once this array is filled.
    refreshTaskTargets();
  } catch (err) {
    $('notice-list').replaceChildren(mkNote('admin-error', '❌ 加载失败: ' + err.message));
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 加载公告';
  }
}

function renderNotices() {
  const published = noticeData.filter(a => a.is_published).length;
  $('notice-count').textContent = noticeData.length
    ? `共 ${noticeData.length} 条 · ${published} 条已发布 · ${noticeData.filter(a => a.pinned).length} 条置顶`
    : '';
  if (!noticeData.length) {
    $('notice-list').replaceChildren(mkNote('admin-empty', '还没有公告。'));
    return;
  }
  $('notice-list').replaceChildren(...noticeData.map(noticeRow));
}

// Every string here is admin-typed and goes in through textContent. Same rule
// as the rest of this file: the announcement body renders on the gallery, on
// the same origin as /admin, so innerHTML anywhere in this path would be a
// stored-XSS hole that the admin writes into themselves.
function noticeRow(a) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'admin-row';

  const info = document.createElement('div');
  info.className = 'admin-row-info';
  const head = document.createElement('div');
  head.className = 'admin-row-name';
  head.textContent = a.title || '(无标题)';
  if (a.pinned) head.append(mkNote('notice-badge pin', '📌 置顶'));
  if (!a.is_published) head.append(mkNote('notice-badge draft', '草稿'));
  const preview = document.createElement('div');
  preview.className = 'admin-row-sub notice-preview';
  preview.textContent = a.body || '';
  const meta = document.createElement('div');
  meta.className = 'admin-row-sub';
  meta.textContent = `#${a.id} · ${a.created_at}`
    + (a.updated_at && a.updated_at !== a.created_at ? ` · 编辑于 ${a.updated_at}` : '');
  info.append(head, preview, meta);

  const acts = document.createElement('div');
  acts.className = 'admin-row-actions';

  const edit = document.createElement('button');
  edit.className = 'btn-file-action btn-rename';
  edit.textContent = '✏️ 编辑';
  edit.addEventListener('click', () => startNoticeEdit(a));

  const pin = document.createElement('button');
  pin.className = 'btn-file-action';
  pin.textContent = a.pinned ? '📌 取消置顶' : '📌 置顶';
  // Only the flag it owns is sent. The editor owns title/body, and this row may
  // have been on screen for a while — posting the whole record from here would
  // write a stale copy of the text back over an edit made since.
  pin.addEventListener('click', () => setNoticeFlags(a, { pinned: !a.pinned }));

  const pub = document.createElement('button');
  pub.className = 'btn-file-action';
  pub.textContent = a.is_published ? '🙈 取消发布' : '👁 发布';
  pub.addEventListener('click', () => setNoticeFlags(a, { is_published: !a.is_published }));

  const view = ATTACH_VIEWS.announcement;
  const panel = document.createElement('div');
  panel.hidden = true;
  panel.className = 'admin-subpanel';
  const media = document.createElement('button');
  media.className = 'btn-file-action';
  media.textContent = view.icon + ' ' + view.noun;
  media.addEventListener('click', () => toggleAttachDetail(view, String(a.id), panel, media));

  const del = document.createElement('button');
  del.className = 'btn-file-action danger';
  del.textContent = '🗑 删除';
  del.addEventListener('click', () => deleteNotice(a));

  acts.append(edit, pin, pub, media, del);
  row.append(info, acts);
  wrap.append(row, panel);
  return wrap;
}

function startNoticeEdit(a) {
  noticeEditingId = a.id;
  $('notice-title').value = a.title || '';
  $('notice-body').value = a.body || '';
  $('notice-pinned').checked = !!a.pinned;
  $('notice-published').checked = !!a.is_published;
  $('btn-notice-save').textContent = '✅ 保存修改 #' + a.id;
  $('btn-notice-cancel').hidden = false;
  $('notice-result').hidden = true;
  $('notice-title').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function resetNoticeEditor() {
  noticeEditingId = null;
  $('notice-title').value = '';
  $('notice-body').value = '';
  $('notice-pinned').checked = false;
  $('notice-published').checked = true;
  $('btn-notice-save').textContent = '✅ 发布公告';
  $('btn-notice-cancel').hidden = true;
}

$('btn-notice-cancel').addEventListener('click', () => {
  resetNoticeEditor();
  $('notice-result').hidden = true;
});

$('btn-notice-save').addEventListener('click', async () => {
  const title = $('notice-title').value.trim();
  // Not trimmed: the feed renders the body with `white-space: pre-wrap`, so the
  // admin's own line breaks and indentation are content. Only the both-empty
  // check looks past the whitespace.
  const body = $('notice-body').value;
  if (!title && !body.trim()) {
    showNoticeResult(false, '❌ 标题和正文不能都为空。');
    return;
  }

  const editing = noticeEditingId;
  const btn = $('btn-notice-save');
  const restore = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 保存中...';
  try {
    const resp = await fetch(
      editing ? '/admin/api/announcements/' + editing : '/admin/api/announcements',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body,
          pinned: $('notice-pinned').checked,
          is_published: $('notice-published').checked,
        }),
      });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || 'HTTP ' + resp.status);
    resetNoticeEditor();
    showNoticeResult(true, editing
      ? '✅ 公告 #' + editing + ' 已更新。'
      : '✅ 公告已创建 (#' + data.id + ')。' +
        ($('notice-published').checked ? '' : ' 仍是草稿，传完附件后记得发布。'));
    await loadNotices();
  } catch (err) {
    showNoticeResult(false, '❌ 保存失败: ' + err.message);
  } finally {
    btn.disabled = false;
    if (btn.textContent === '⏳ 保存中...') btn.textContent = restore;
  }
});

async function setNoticeFlags(a, patch) {
  try {
    const resp = await fetch('/admin/api/announcements/' + a.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    await loadNotices();
  } catch (err) {
    alert('操作失败: ' + err.message);
  }
}

async function deleteNotice(a) {
  // The count of attached media is not in this row — it costs a request, and
  // this list is loaded in full. The warning says what will go, and the server
  // deletes the objects before the row, so a failed run leaves the announcement
  // listed and retryable rather than half gone.
  if (!confirm('确认删除公告 "' + (a.title || a.body || '#' + a.id).slice(0, 40)
      + '"？其图片、视频和附件也会一并删除，且不可撤销。')) return;
  try {
    const resp = await fetch('/admin/api/announcements/' + a.id, { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || 'HTTP ' + resp.status);
    if (noticeEditingId === a.id) resetNoticeEditor();
    showNoticeResult(true, '✅ 公告已删除' +
      (data.deleted_media ? `（含 ${data.deleted_media} 个附件）` : '') + '。');
    await loadNotices();
  } catch (err) {
    showNoticeResult(false, '❌ 删除失败: ' + err.message);
  }
}

function showNoticeResult(ok, text) {
  const box = $('notice-result');
  box.hidden = false;
  box.className = 'admin-result ' + (ok ? 'ok' : 'err');
  box.textContent = text;
}

// The 公告 section is the one attach target that is not in the file listing, so
// it is loaded once at startup — otherwise picking 「📢 公告附件」 offers an
// empty dropdown until the admin happens to click 加载公告.
loadNotices();

// ── Dashboard ──
//
// Read-only, and the only section that is not a form: it answers "what is
// going on" so the rest of the page can stay "change this one thing".
let dashDays = 7;

document.getElementById('dash-range').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  for (const t of document.querySelectorAll('#dash-range .range-tab')) {
    const on = t === btn;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  dashDays = parseInt(btn.dataset.days, 10) || 7;
  loadDashboard();
});
$('btn-dash-refresh').addEventListener('click', loadDashboard);

async function loadDashboard() {
  const btn = $('btn-dash-refresh');
  btn.disabled = true;
  try {
    const resp = await fetch('/admin/api/dashboard?days=' + dashDays);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const d = await resp.json();
    renderStats(d.overview || {});
    renderDashChart(d.daily || [], d.days || dashDays);
    renderDashTop(d.top || []);
    $('dash-updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
  } catch (err) {
    $('stat-grid').replaceChildren(mkNote('admin-error', '❌ 概览加载失败: ' + err.message));
  } finally {
    btn.disabled = false;
  }
}

function renderStats(o) {
  // `sub` is the second line, and it is where a number that would otherwise
  // need explaining goes — "23 个" alone does not say 23 of what is public.
  const tiles = [
    { icon: '▶️', label: '总播放', value: fmtCount(o.all_plays), accent: 'play' },
    { icon: '⬇️', label: '总下载', value: fmtCount(o.all_downloads), accent: 'dl' },
    { icon: '🎬', label: '文件', value: fmtCount(o.files), sub: formatSize(o.total_size || 0) },
    { icon: '📹', label: '代理 / 关联', value: `${fmtCount(o.proxies)} / ${fmtCount(o.attachments)}` },
    { icon: '✂️', label: '切片', value: fmtCount(o.clips), sub: `公开 ${fmtCount(o.public_clips)}` },
    { icon: '📚', label: '归档', value: fmtCount(o.clip_sets) },
    { icon: '📢', label: '公告', value: fmtCount(o.announcements), sub: `已发布 ${fmtCount(o.published_announcements)}` },
    { icon: '🚩', label: '待处理举报', value: fmtCount(o.open_reports), accent: o.open_reports > 0 ? 'warn' : '' },
  ];
  $('stat-grid').replaceChildren(...tiles.map(t => {
    const card = document.createElement('div');
    card.className = 'stat-tile' + (t.accent ? ' accent-' + t.accent : '');
    const icon = document.createElement('div');
    icon.className = 'stat-icon';
    icon.textContent = t.icon;
    const val = document.createElement('div');
    val.className = 'stat-value';
    val.textContent = t.value;
    const lab = document.createElement('div');
    lab.className = 'stat-label';
    lab.textContent = t.label;
    card.append(icon, val, lab);
    if (t.sub) {
      const sub = document.createElement('div');
      sub.className = 'stat-sub';
      sub.textContent = t.sub;
      card.append(sub);
    }
    return card;
  }));
}

// A CSS bar chart, not a charting library: this page has no build step and no
// external requests, and two series over at most 90 buckets is a flexbox.
//
// **Every day in the window gets a column**, present in the data or not. The
// server only returns days that have rows, so a brand-new install returned one
// day — and one `flex: 1` column fills the whole panel, which on a wide screen
// drew its two bars as a 500px-wide half-pink half-blue slab that looked like a
// rendering bug rather than a chart. Filling the range also makes the x-axis
// mean something: a gap is a quiet day, not a missing column.
function renderDashChart(daily, days) {
  const host = $('dash-chart');
  if (!daily.length) {
    host.replaceChildren(mkNote('admin-empty', '这段时间还没有播放或下载记录。'));
    return;
  }
  const byDay = new Map(daily.map(d => [d.day, d]));
  const today = new Date();
  const cols = [];
  for (let i = days - 1; i >= 0; i--) {
    // Built in UTC because `date('now')` in D1 is UTC — walking local days
    // would slide the buckets by the viewer's offset and double- or zero-count
    // a day at the edge.
    const d = new Date(Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    cols.push(byDay.get(key) || { day: key, plays: 0, downloads: 0 });
  }

  // Scale to the tallest single bar so the shape is readable; both series share
  // it, or "downloads" would look as big as "plays" at a tenth the count.
  const peak = Math.max(...cols.map(d => Math.max(d.plays, d.downloads)), 1);
  // At 90 buckets a label per column is an unreadable smear, so thin them to
  // about a dozen. The tooltip still names every day exactly.
  const step = Math.ceil(cols.length / 12);

  host.replaceChildren(...cols.map((d, i) => {
    const col = document.createElement('div');
    col.className = 'chart-col';
    col.title = `${d.day} (UTC) · 播放 ${d.plays} · 下载 ${d.downloads}`;
    const bars = document.createElement('div');
    bars.className = 'chart-bars';
    for (const [cls, v] of [['play', d.plays], ['dl', d.downloads]]) {
      const bar = document.createElement('div');
      bar.className = 'chart-bar ' + cls;
      // A count of 0 keeps a hairline so the day reads as "nothing" rather
      // than as a gap in the axis.
      bar.style.height = (v > 0 ? Math.max(4, Math.round((v / peak) * 100)) : 1) + '%';
      bars.append(bar);
    }
    const lab = document.createElement('div');
    lab.className = 'chart-label';
    // MM-DD; the year is the same all the way across.
    lab.textContent = (i % step === 0 || i === cols.length - 1) ? d.day.slice(5) : '';
    col.append(bars, lab);
    return col;
  }));
}

function renderDashTop(rows) {
  const host = $('dash-top');
  if (!rows.length) {
    host.replaceChildren(mkNote('admin-empty', '暂无数据。'));
    return;
  }
  const peak = Math.max(...rows.map(r => r.plays + r.downloads), 1);
  host.replaceChildren(...rows.map((r, i) => {
    const row = document.createElement('div');
    row.className = 'top-row';
    const rank = document.createElement('span');
    rank.className = 'top-rank';
    rank.textContent = String(i + 1);
    const body = document.createElement('div');
    body.className = 'top-body';
    const name = document.createElement('div');
    name.className = 'top-name';
    // A path is user-controlled text; textContent, like everywhere else here.
    name.textContent = r.file_path.split('/').pop() || r.file_path;
    name.title = r.file_path;
    const meter = document.createElement('div');
    meter.className = 'top-meter';
    const fill = document.createElement('div');
    fill.className = 'top-meter-fill';
    fill.style.width = Math.round(((r.plays + r.downloads) / peak) * 100) + '%';
    meter.append(fill);
    body.append(name, meter);
    const nums = document.createElement('span');
    nums.className = 'top-nums';
    nums.textContent = `▶️ ${fmtCount(r.plays)} · ⬇️ ${fmtCount(r.downloads)}`;
    row.append(rank, body, nums);
    return row;
  }));
}

function fmtCount(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? (v / 1000).toFixed(1) + 'k' : String(v);
}

loadDashboard();

// ── Collapsible sections ──
//
// Applied from JS rather than written into `admin.html` eight times: every
// section is `<div class="admin-section" id="sec-*"><h2>…`, so the header is
// derivable, and a ninth section gets this for free instead of being the one
// that silently does not.
//
// Only *collapsed* is persisted, and nothing collapses on its own. An
// auto-collapse would eventually hide the upload progress bar and the resume
// banner mid-transfer, which is the one state on this page you cannot afford
// not to see — `expandUploadSection()` below exists for exactly that case.
const SECTION_COLLAPSE_KEY = 'zcll.admin.collapsed';

function collapsedSections() {
  try { return new Set(JSON.parse(localStorage.getItem(SECTION_COLLAPSE_KEY) || '[]')); }
  catch (_) { return new Set(); }
}

function setSectionCollapsed(section, collapsed) {
  section.classList.toggle('collapsed', collapsed);
  const btn = section.querySelector('.section-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  const stored = collapsedSections();
  if (collapsed) stored.add(section.id); else stored.delete(section.id);
  try { localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify([...stored])); }
  catch (_) { /* the toggle still works for this page view */ }
}

function initCollapsibleSections() {
  const stored = collapsedSections();
  for (const section of document.querySelectorAll('.admin-section')) {
    const h2 = section.querySelector('h2');
    if (!h2 || !section.id) continue;
    // The heading becomes the control. A <button> inside the <h2> keeps the
    // heading a heading for a screen reader while making the whole strip a real
    // keyboard-reachable control — a click handler on a bare <h2> is neither.
    const btn = document.createElement('button');
    btn.className = 'section-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'true');
    const chevron = document.createElement('span');
    chevron.className = 'section-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▾';
    const label = document.createElement('span');
    label.textContent = h2.textContent;
    btn.append(chevron, label);
    h2.replaceChildren(btn);
    btn.addEventListener('click', () =>
      setSectionCollapsed(section, !section.classList.contains('collapsed')));
    if (stored.has(section.id)) setSectionCollapsed(section, true);
  }
}

// Called when an upload starts. A section collapsed in a previous visit is
// restored collapsed at load, so without this the progress bar, the wake-lock
// hint and the resume banner would all be behind a shut header for the whole
// transfer.
function expandUploadSection() {
  const sec = document.getElementById('sec-upload');
  if (sec && sec.classList.contains('collapsed')) setSectionCollapsed(sec, false);
}

initCollapsibleSections();

function $(id) { return document.getElementById(id); }
function mkNote(cls, text) {
  const s = document.createElement('span'); s.className = cls; s.textContent = text; return s;
}
function mkLabel(text) { const b = document.createElement('b'); b.textContent = text; return b; }
// loadFiles() calls updateProxySection() directly — no wrapper. The wrapper
// that used to live here was installed *after* the initial loadFiles() call
// higher up the script, so the proxy section stayed empty until an upload,
// rename or delete happened to reload the list.

// Stored sessions outlive the page, so surface them as tasks on load. There is
// no File yet, so each one asks for its own file back rather than resuming
// outright. Last in the file because a row names its target, and an
// announcement's title is read from `noticeData` — declared above, but only
// initialised once this script has run to here.
migrateLegacySession();
for (const s of loadAllSessions()) adoptSession(s);
renderQueueSummary();
