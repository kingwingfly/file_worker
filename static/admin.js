'use strict';

const fileInput = document.getElementById('file-input');
const uploadZone = document.getElementById('upload-zone');
const uploadBtn = document.getElementById('upload-btn');
const progressWrapper = document.getElementById('progress-wrapper');
const progressBar = document.getElementById('progress-bar');
const uploadResult = document.getElementById('upload-result');
const customPath = document.getElementById('custom-path');
const fileListEl = document.getElementById('admin-file-list');
const attachTargetSelect = document.getElementById('attach-target');
const attachLabelInput = document.getElementById('attach-label');
let selectedFile = null;

// ── Upload mode ──
// 'file' uploads a new object; 'proxy' attaches a low-quality playback source
// to an existing one; 'attachment' attaches a downloadable related file
// (subtitles, transcripts); 'announcement' attaches an image, video or PDF to
// an announcement. Everything between /start and /complete is identical —
// /admin/api/upload/part serves all four — so they share this whole uploader,
// resume and wake lock included.
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
  if (!selectedFile) {
    document.getElementById('upload-zone-hint').textContent =
      spec ? spec.zoneHint : '支持 JPG, PNG, GIF, MP4, WEBM, MP3, WAV 等';
  }
  refreshUploadButton();
}

// In every attach mode the target is as required as the file itself — without
// one there is nothing to attach the upload to.
function refreshUploadButton() {
  const needsTarget = !!attachSpec(uploadMode()) && !attachTargetSelect.value;
  uploadBtn.disabled = !selectedFile || needsTarget;
}

document.querySelectorAll('input[name="upload-mode"]').forEach(r =>
  r.addEventListener('change', applyUploadMode));
attachTargetSelect.addEventListener('change', refreshUploadButton);

// File selection
function onFileChosen(file) {
  if (!file) return;
  selectedFile = file;
  refreshUploadButton();
  document.querySelector('.upload-zone-text').textContent = file.name;
  document.getElementById('upload-zone-hint').textContent =
    formatSize(file.size) + ' — ' + (file.type || 'unknown');
  // A File handle cannot survive a page reload, so a session restored from
  // localStorage has no bytes to send until the admin picks the same file
  // again. This is where that reconnection happens.
  const session = loadSession();
  if (session && sessionMatches(session, file)) showResumeBanner(file);
}

fileInput.addEventListener('change', () => onFileChosen(fileInput.files[0]));

// Drag & drop
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    onFileChosen(file);
  }
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
    // admin cancelled the overwrite dialog, say. It had no sentinel to
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

// Closing the tab mid-upload kills the transfer and strands the multipart
// upload in R2 — the abort call lives in doMultipartUpload's catch, which
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
const SESSION_KEY = 'zcll.upload.session';
const PART_RETRIES = 6;          // 1+2+4+8+16s ≈ 31s of backoff
const OFFLINE_WAIT_MS = 120000;  // per offline pause
const MAX_OFFLINE_WAITS = 5;     // ≈10 min of tolerated disconnection
let resumeFile = null; // in-memory File matching the stored session, if any

const resumeBanner = document.getElementById('resume-banner');
const resumeText = document.getElementById('resume-text');
const btnResume = document.getElementById('btn-resume');
const btnDiscard = document.getElementById('btn-discard');

function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) { /* private mode / quota */ }
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* nothing to do */ }
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

function showResumeBanner(file) {
  const s = loadSession();
  if (!s) { resumeBanner.hidden = true; return; }
  resumeFile = file && sessionMatches(s, file) ? file : null;
  const total = sessionChunks(s);
  const pct = Math.round((s.parts.length / total) * 100);
  const progress = `${s.parts.length}/${total} 分片 (${pct}%)`;
  resumeText.textContent = resumeFile
    ? `⏸ "${s.file.name}" 已上传 ${progress}，可继续。`
    : `⏸ 有未完成的上传: "${s.file.name}" — ${progress}。请重新选择同一个文件以继续。`;
  btnResume.disabled = !resumeFile;
  resumeBanner.hidden = false;
}

btnResume.addEventListener('click', () => {
  const s = loadSession();
  if (!s || !resumeFile || !sessionMatches(s, resumeFile)) {
    releaseWakeLock(); // no upload is starting; don't hold the screen awake
    showResult(false, '❌ 所选文件与未完成的上传不匹配，无法续传。');
    return;
  }
  resumeBanner.hidden = true;
  acquireWakeLock('click'); // this click is the gesture WebKit requires
  runUpload(resumeFile, s);
});

btnDiscard.addEventListener('click', async () => {
  const s = loadSession();
  resumeBanner.hidden = true;
  resumeFile = null;
  clearSession();
  await abortSession(s);
  showResult(true, '🗑 已放弃未完成的上传，服务端分片已清理。');
});

// A stored session outlives the page, so surface it on load. There is no
// File yet, so the banner asks for a re-selection rather than offering
// Resume outright.
if (loadSession()) showResumeBanner(null);

// Upload — multipart for large files
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
const dupWarning = document.getElementById('dup-warning');
const dupKeyEl = document.getElementById('dup-key');
const btnOverwrite = document.getElementById('btn-overwrite');
const btnCancelOverwrite = document.getElementById('btn-cancel-overwrite');
let pendingOverwriteFile = null;
let pendingOverwritePath = null;

// pointerdown is the earliest event carrying transient activation, and it
// fires well before the click handler's own request. Costs nothing when
// that one would have succeeded anyway, and widens the window when it
// wouldn't — the shared in-flight guard means only one request is made.
uploadBtn.addEventListener('pointerdown', () => {
  if (selectedFile) acquireWakeLock('pointerdown');
});

uploadBtn.addEventListener('click', () => {
  if (!selectedFile) return;
  // Ask for the lock here, synchronously in the gesture, not later in
  // doMultipartUpload — that runs after the check-key round trip, by which
  // point any transient activation has expired. MDN's examples acquire from
  // a click for exactly this reason, on every engine. Before the mode
  // branch, because the branch below is what would cost the activation.
  acquireWakeLock('click');

  const mode = uploadMode();
  const spec = attachSpec(mode);
  if (spec) {
    const target = attachTargetSelect.value;
    if (!target) { releaseWakeLock(); showResult(false, '❌ 请先选择上传目标。'); return; }
    // No check-key: that endpoint tests `files.path` for collisions, and
    // everything attached deliberately has no uniqueness on its target (many
    // proxies per file, many attachments per file, many media per announcement
    // is the point). Running it would raise the overwrite dialog over an
    // unrelated file, and overwrite means nothing here. In the announcement
    // mode it would not even be asking about the right table.
    doMultipartUpload(selectedFile, '', false, {
      mode,
      target,
      label: attachLabelInput.value.trim() || spec.fallbackLabel,
    });
    return;
  }
  checkDuplicateThenUpload(selectedFile, customPath.value.trim());
});

btnOverwrite.addEventListener('click', () => {
  dupWarning.hidden = true;
  if (pendingOverwriteFile) {
    acquireWakeLock('click'); // fresh gesture; the check-key pause released it
    doMultipartUpload(pendingOverwriteFile, pendingOverwritePath, true);
    pendingOverwriteFile = null;
    pendingOverwritePath = null;
  }
});

btnCancelOverwrite.addEventListener('click', () => {
  dupWarning.hidden = true;
  pendingOverwriteFile = null;
  pendingOverwritePath = null;
  releaseWakeLock();
  uploadBtn.disabled = false;
  uploadBtn.textContent = '🚀 上传';
});

async function checkDuplicateThenUpload(file, path) {
  uploadBtn.disabled = true;
  uploadBtn.textContent = '⏳ 检查重名...';
  uploadResult.hidden = true;
  dupWarning.hidden = true;

  try {
    const checkResp = await fetchWithRetry('/admin/api/files/check-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        path: path || undefined,
      }),
    });
    if (!checkResp.ok) {
      // If check fails, proceed anyway — server will catch duplicates
      doMultipartUpload(file, path, false);
      return;
    }
    const checkData = await checkResp.json();

    if (checkData.exists) {
      // No upload is starting — hand the lock back rather than holding the
      // screen awake while the dialog waits for a decision. If the admin
      // abandons the dialog instead of answering, the browser releases the
      // lock itself the moment the tab is hidden, so the worst case is
      // bounded. The other exits from this function (check failed, or it
      // threw) fall through to doMultipartUpload and keep the lock.
      releaseWakeLock();
      dupKeyEl.textContent = checkData.path;
      dupWarning.hidden = false;
      pendingOverwriteFile = file;
      pendingOverwritePath = path;
      uploadBtn.textContent = '🚀 上传';
    } else {
      doMultipartUpload(file, path, false);
    }
  } catch (_) {
    // Check failed — proceed anyway
    doMultipartUpload(file, path, false);
  }
}

// Opens a fresh multipart upload, then hands off to runUpload. Split from
// the transfer loop so that resuming can re-enter the loop with a stored
// session and never call /upload/start twice — a second start would mint a
// second key and orphan everything already uploaded under the first.
async function doMultipartUpload(file, path, overwrite, attachTarget) {
  uploadBtn.disabled = true;
  uploadBtn.textContent = '⏳ 创建上传...';
  uploadResult.hidden = true;
  dupWarning.hidden = true;

  const contentType = file.type || 'application/octet-stream';
  const spec = attachTarget ? attachSpec(attachTarget.mode) : null;
  let session;
  try {
    const startResp = spec
      ? await fetchWithRetry(spec.startUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Computed key: the target is a file path in two modes and an
            // announcement id in the third, and the server reads whichever
            // name its own table is keyed on.
            [spec.targetParam]: attachTarget.target,
            filename: file.name,
            content_type: contentType,
            label: attachTarget.label,
          }),
        })
      : await fetchWithRetry('/admin/api/upload/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            content_type: contentType,
            path: path || undefined,
            overwrite: overwrite || false,
          }),
        });
    if (!startResp.ok) {
      const errData = await startResp.json().catch(() => ({}));
      if (startResp.status === 409 && errData.error === 'duplicate') {
        showResult(false, `❌ 文件已存在: ${errData.path}。请刷新页面后重试。`);
        uploadBtn.textContent = '🚀 上传';
        uploadBtn.disabled = false;
        return;
      }
      throw new Error(`Start failed: ${startResp.status}`);
    }
    const startData = await startResp.json();
    session = {
      upload_id: startData.upload_id,
      key: startData.key,       // server-minted; resume replays it, never re-mints
      path: startData.path,
      contentType,
      chunkSize: chunkSizeFor(file.size),
      overwrite: !!overwrite,
      // Read back through `attachSpec(session.mode)`, so a session written
      // before attach modes existed (no `mode`, or `mode: 'file'`) resolves to
      // a plain file upload without a special case.
      mode: attachTarget ? attachTarget.mode : 'file',
      // Legacy field name, read back through `sessionAttachTarget()` — see there.
      attachFilePath: attachTarget ? attachTarget.target : undefined,
      attachLabel: attachTarget ? attachTarget.label : undefined,
      parts: [],
      file: { name: file.name, size: file.size, lastModified: file.lastModified },
    };
    // Only one session is stored, so starting a new upload evicts whatever
    // was there. Abort it rather than leaving its parts stranded in R2 with
    // nothing left that knows the upload_id.
    const stale = loadSession();
    if (stale && stale.upload_id !== session.upload_id) await abortSession(stale);
    saveSession(session);
  } catch (err) {
    console.error('Upload start failed:', err);
    showResult(false, `❌ 上传失败: ${err.message}`);
    uploadBtn.textContent = '🚀 上传';
    uploadBtn.disabled = false;
    return;
  }

  await runUpload(file, session);
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

function renderProgress(loaded, size) {
  // size 0 is a legitimate upload (R2 still wants one empty part), and
  // 0/0 would put NaN in the width.
  progressBar.style.width = (size > 0 ? Math.round((loaded / size) * 100) : 100) + '%';
  document.getElementById('progress-text').textContent =
    `${formatSize(loaded)} / ${formatSize(size)}`;
}

// The transfer loop. Entered both by a fresh upload and by Resume, and it
// cannot tell the difference — the only input is the session.
async function runUpload(file, session) {
  uploadBtn.disabled = true;
  progressWrapper.hidden = false;
  uploadResult.hidden = true;
  dupWarning.hidden = true;

  uploadInProgress = true;
  // Deliberately does NOT request a lock. runUpload is reached after the
  // check-key and /upload/start round trips, so it has no user activation
  // left and WebKit refuses — which would overwrite a lock the click
  // already secured with a spurious "refused" hint. Report the click's
  // result instead, waiting for it if it is still in flight.
  settleWakeHint();

  // Always the session's chunk size, never chunkSizeFor(). R2 requires every
  // part but the last to be identically sized, so raising the constant
  // would silently corrupt any session started under the old one.
  const totalChunks = sessionChunks(session);
  const done = new Map(session.parts.map(p => [p.n, p]));
  renderProgress(bytesDone(done, session), file.size);

  try {
    for (let i = 0; i < totalChunks; i++) {
      const n = i + 1;
      if (done.has(n)) continue; // already committed in an earlier attempt

      const start = i * session.chunkSize;
      const chunk = file.slice(start, Math.min(start + session.chunkSize, file.size));
      const base = bytesDone(done, session);

      uploadBtn.textContent = `⏳ 上传中 ${n}/${totalChunks}...`;
      const part = await uploadChunkWithRetry(session, n, chunk, (chunkLoaded) => {
        renderProgress(base + chunkLoaded, file.size);
      });

      done.set(n, { n: part.part_number, etag: part.etag });
      session.parts = [...done.values()].sort((a, b) => a.n - b.n);
      saveSession(session);
      renderProgress(bytesDone(done, session), file.size);
    }

    uploadBtn.textContent = '⏳ 完成中...';
    progressBar.style.width = '100%';

    // Complete is the one step that must never be blindly retried: a
    // success whose response was lost leaves the multipart upload consumed,
    // so a second attempt errors forever over a file that is already in the
    // bucket. Reconcile against the listing before believing the failure.
    let completeData;
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
        // fatal — the server has already refused, so Resume can only loop.
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
      completeData = await completeResp.json();
    } catch (err) {
      if (err.fatal) throw err;
      const landed = await uploadLanded(session);
      if (landed) {
        completeData = { path: landed.path, size: landed.size };
      } else {
        // Genuinely not committed. Resume can retry this, but only twice —
        // if complete() consumed the upload and the D1 insert then failed,
        // the handler deleted the object and no retry can ever succeed.
        // Bail out rather than leaving the admin in a Resume loop.
        session.completeFailures = (session.completeFailures || 0) + 1;
        saveSession(session);
        if (session.completeFailures >= 2) {
          throw uploadError(`无法完成上传（${err.message}）。请放弃并重新上传。`, err.status, true);
        }
        throw err;
      }
    }

    clearSession();
    resumeFile = null;
    resumeBanner.hidden = true;
    // An attached upload has no display path of its own — it belongs to a file
    // or an announcement, and no attach completion returns `path`. Reading
    // `.path` here is what printed "→ undefined". The session's own target is
    // the fallback, and the only thing the announcement mode can print.
    const doneSpec = attachSpec(session.mode);
    showResult(true, doneSpec
      ? `${doneSpec.okPrefix} ${sessionAttachLabel(session)} → ${completeData.file_path || sessionAttachTarget(session)} (${formatSize(completeData.size)})`
      : `✅ 上传成功! ${completeData.path} (${formatSize(completeData.size)})`);
    customPath.value = '';
    selectedFile = null;
    fileInput.value = '';
    document.querySelector('.upload-zone-text').textContent = '点击或拖拽到此处';
    applyUploadMode();  // restores the mode's own zone hint and button state
    loadFiles();

  } catch (err) {
    console.error('Upload error:', err);
    const resumable = session.parts.length > 0 && !err.fatal;
    if (resumable) {
      // Deliberately no abort call. Aborting here is what used to throw
      // away every part already transferred; leaving the multipart upload
      // open is what makes Resume possible at all. The cost is an orphaned
      // upload in R2 if the admin never comes back — Discard cleans it up,
      // and an R2 lifecycle rule is the backstop for the rest.
      saveSession(session);
      showResult(false,
        `⏸ 上传中断: ${err.message} — 已保留 ${session.parts.length}/${totalChunks} 个分片，可继续。`);
      showResumeBanner(file);
    } else {
      await abortSession(session);
      clearSession();
      resumeFile = null;
      resumeBanner.hidden = true;
      showResult(false, `❌ 上传失败: ${err.message}`);
    }
  } finally {
    // A paused upload is not an upload in progress: the lock comes off and
    // beforeunload stops warning, because the session now survives a reload
    // and Resume re-acquires the lock inside its own click.
    uploadInProgress = false;
    releaseWakeLock();
    uploadBtn.disabled = !selectedFile;
    uploadBtn.textContent = '🚀 上传';
    setTimeout(() => {
      progressWrapper.hidden = true;
      wakeHint.hidden = true;
    }, 1500);
  }
}

// `fatal` marks a failure that resuming cannot fix, so the catch in
// runUpload aborts and clears instead of offering a Resume that is
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
  // set is what turned every one of them into a manual Resume.
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

async function uploadChunkWithRetry(session, partNumber, blob, onProgress) {
  let attempt = 0;
  let offlineWaits = 0;
  for (;;) {
    try {
      return await uploadChunk(session.upload_id, session.key, partNumber, blob, onProgress);
    } catch (err) {
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
        uploadBtn.textContent = `📴 分片 ${partNumber} 等待网络恢复...`;
        await waitForOnline(OFFLINE_WAIT_MS);
        continue;
      }

      attempt++;
      if (attempt >= PART_RETRIES) throw err;
      uploadBtn.textContent = `⏳ 分片 ${partNumber} 重试 ${attempt}/${PART_RETRIES - 1}...`;
      await sleep(1000 * Math.pow(2, attempt - 1));
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
    // failures send the admin to Discard over an object sitting in the bucket.
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

function uploadChunk(uploadId, key, partNumber, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded);
      }
    });

    xhr.addEventListener('load', () => {
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

    // status 0 on both: no response ever arrived, so this is retryable.
    xhr.addEventListener('error', () => reject(uploadError(`分片 ${partNumber}: 网络错误`, 0)));
    xhr.addEventListener('timeout', () => reject(uploadError(`分片 ${partNumber}: 超时`, 0)));

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
    delBtn.addEventListener('click', () => deleteFile(path));

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
      actions.append(attachBtn);
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
// proxies all hang off `files.path`. The server refuses a bare DELETE whenever
// any of them exist and answers 409 `confirm_required` with the counts, so this
// runs in two round trips — ask, then act on the admin's choice. A file with
// nothing attached (the common case) still deletes on the first call, so the
// dialog only ever appears when there is something to lose.
async function deleteFile(path) {
  // This confirm stays, and stays *first*. The impact is only known from the
  // server's refusal, which arrives after the request — so discovering the
  // impact cannot be what gates the first destructive call. A bare file (the
  // common case) is deleted by that call, exactly as before.
  if (!confirm(`确认删除 "${path}"?`)) return;
  let plan;
  try {
    const resp = await fetch(`/admin/api/files/${encodePath(path)}`, { method: 'DELETE' });
    if (resp.ok) { loadFiles(); return; }
    if (resp.status !== 409) { alert('删除失败: ' + await errorMessage(resp)); return; }
    plan = await resp.json();
    if (plan.error !== 'confirm_required') { alert('删除失败: ' + (plan.message || '')); return; }
  } catch (err) {
    alert('网络错误: ' + err.message);
    return;
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
  const lost = [];
  if (plan.clips) lost.push(`${plan.clips} 个切片`);
  if (plan.clip_sets) lost.push(`${plan.clip_sets} 个切片合集`);
  if (plan.attachments) lost.push(`${plan.attachments} 个关联文件`);
  if (proxies.length) lost.push(`${proxies.length} 个代理`);
  const line = document.createElement('p');
  line.textContent = '该文件关联了 ' + (lost.join('、') || '内容') + '。';
  impact.appendChild(line);

  const promoteBox = overlay.querySelector('.delete-promote');
  const promoteBtn = overlay.querySelector('.btn-delete-promote');
  const select = overlay.querySelector('#promote-select');
  const hint = overlay.querySelector('#promote-hint');

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
    warn.textContent = '没有代理可以接替原片，以上内容将一并永久删除，无法恢复。';
    impact.appendChild(warn);
  }

  document.body.appendChild(overlay);

  const purgeBtn = overlay.querySelector('.btn-delete-purge');
  const cancelBtn = overlay.querySelector('.btn-rename-cancel');
  const close = () => overlay.remove();

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
  purgeBtn.addEventListener('click', () => {
    if (!confirm(`确认永久删除 "${path}" 及其全部关联内容？`)) return;
    send('mode=purge', '⏳ ...', purgeBtn);
  });
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
      <label class="rename-label" for="rename-input">新文件名</label>
      <input type="text" id="rename-input" autofocus>
      <div class="rename-hint">只改文件名，保留目录路径。输入完整路径可移动到其他目录。</div>
      <div class="rename-dialog-actions">
        <button class="btn-rename-cancel">取消</button>
        <button class="btn-rename-confirm">确认重命名</button>
      </div>
    </div>
  `;
  overlay.querySelector('.rename-oldpath').textContent = '原路径: ' + oldPath;
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
    if (!newName) { alert('文件名不能为空'); return; }
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

function $(id) { return document.getElementById(id); }
function mkNote(cls, text) {
  const s = document.createElement('span'); s.className = cls; s.textContent = text; return s;
}
function mkLabel(text) { const b = document.createElement('b'); b.textContent = text; return b; }
// loadFiles() calls updateProxySection() directly — no wrapper. The wrapper
// that used to live here was installed *after* the initial loadFiles() call
// higher up the script, so the proxy section stayed empty until an upload,
// rename or delete happened to reload the list.
