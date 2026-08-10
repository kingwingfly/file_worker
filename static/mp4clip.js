/* mp4clip.js — cut an MP4 in the browser, without re-encoding anything.
 *
 * The ffmpeg command this sits next to is correct and will always be the
 * fallback, but it asks the viewer to install a toolchain to get a 20 second
 * clip. This does the same job in the page: it is a *remux*, not a transcode —
 * the compressed samples are copied byte-for-byte out of the original and
 * wrapped in a fresh MP4 container.
 *
 * Why this is cheap even for a 40 GB source:
 *
 *   1. Walk the top-level boxes with 16-byte Range requests until `moov` turns
 *      up (2–3 requests whether or not the file has +faststart), then fetch
 *      just that box.
 *   2. `moov` holds the sample tables: for every sample, its decode time, its
 *      byte offset and its size. So the [start, end) window resolves to a set
 *      of byte ranges *before* a single byte of media is fetched — which is
 *      also how the exact output size is known up front.
 *   3. Fetch only those ranges and write a new container around them.
 *
 * Nothing here inspects the bitstream. `stsd` — the sample description, which
 * carries the codec's own configuration record — is copied over verbatim, so
 * H.264, HEVC and AV1 all work for the same reason and none of them is named
 * anywhere in this file. That is the same reasoning as the `canPlayType` note
 * in CLAUDE.md: the container is knowable, the contents are not, so don't try.
 *
 * Two deliberate limits, both surfaced in the UI rather than hidden:
 *
 *   - **The cut snaps back to the previous keyframe.** A frame in the middle of
 *     a GOP cannot be decoded without the ones before it, and decoding is
 *     exactly what we are refusing to do. `ffmpeg -ss T -i in -c copy` snaps the
 *     same way, so the one-click output matches the command shown beside it.
 *     `plan()` returns `actualStart` so the button can say where the cut lands.
 *   - Only the **first non-empty entry** of the source's edit list is honoured.
 *     A leading empty edit (`media_time == -1`) is a blank period before the
 *     media starts; we are cutting from inside the media, so there is nothing
 *     for it to delay and dropping it is correct.
 *
 * The one thing that is *not* optional is emitting an `elst` of our own. It was
 * left out at first, and both the AAC priming delay and the composition-time
 * shift then leaked into the output: video came back at `start_time=0.066667`
 * against audio at `0.000`, a 67 ms lag — past the point where a viewer sees it.
 * ffmpeg's own `-ss 5 -c copy` writes `[(7167, 1024), (7028, 3412)]` and lands
 * both streams on 0.000. One formula reproduces both of those numbers:
 *
 *     media_time = sourceEditOffset + t0 * timescale - firstKeptSampleDts
 *
 * and it is provably ≥ 0 (the first kept sample presents at or before `t0`), so
 * a version-0 `elst` is always enough and the signed-`ctts` compatibility
 * question never comes up. `ctts` is therefore copied through **verbatim** — the
 * derivation above assumes unmodified composition offsets, and normalising them
 * as well would trim the same shift twice.
 *
 * Declines are explicit and always name a reason: fragmented MP4 (samples live
 * in `moof`, not `moov`), a non-MP4 container, an oversized `moov`, a clip too
 * large to hold in memory. The reason is stated bare — pointing at the ffmpeg
 * command is the caller's job, since only it knows whether one is on screen.
 * Silently producing nothing would be worse than not offering this at all.
 */
(function (global) {
  'use strict';

  // A moov this big means a multi-hour file, and it is a single blocking fetch
  // before anything is on screen. Past this, ffmpeg is genuinely the better tool.
  var MAX_MOOV = 96 * 1024 * 1024;
  // Two sample runs closer than this are read as one request. Bridging a small
  // hole costs the wasted bytes; not bridging it costs a whole round trip.
  var GAP_TOLERANCE = 512 * 1024;
  // Interleave granularity of the output. Small enough that a player never has
  // to seek far between audio and video, large enough to keep stsc compact.
  var CHUNK_SECONDS = 0.5;
  // Refuse rather than fail: the samples have to be in memory to be written, and
  // a tab that dies mid-write has consumed the whole download for nothing.
  var MAX_CLIP_BYTES = 2 * 1024 * 1024 * 1024;
  var U32_MAX = 4294967296;

  // Containers we open. Everything else is copied as an opaque blob — `meta`
  // and `udta` in particular are FullBox-shaped containers whose header is a
  // different size, and there is nothing in them we need.
  var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, edts: 1 };
  // Rebuilt from the slice, so the originals must not survive into the output.
  // sdtp/sbgp/sgpd/stps/cslg are per-sample side tables that would have to be
  // sliced in lockstep; dropping them is always legal and costs nothing here.
  var STBL_REBUILT = {
    stts: 1, ctts: 1, stss: 1, stsc: 1, stsz: 1, stz2: 1, stco: 1, co64: 1,
    sdtp: 1, sbgp: 1, sgpd: 1, stps: 1, cslg: 1
  };

  // ── byte helpers ──────────────────────────────────────────────────────────

  function str4(dv, p) {
    return String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
  }

  function box(type, parts) {
    var len = 8, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    for (i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    var o = 8;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }

  // 64-bit writes go through Math.floor/%, not BigInt: offsets here come from
  // Float64Array (a 40 GB file's chunk offsets do not fit in Int32) and are
  // always integral, so the two halves are exact below 2^53.
  function setU64(dv, p, n) {
    dv.setUint32(p, Math.floor(n / U32_MAX));
    dv.setUint32(p + 4, n >>> 0 === n ? n : n % U32_MAX);
  }

  function getU64(dv, p) { return dv.getUint32(p) * U32_MAX + dv.getUint32(p + 4); }

  // ── box tree ──────────────────────────────────────────────────────────────

  function parseBoxes(dv, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = dv.getUint32(p);
      var type = str4(dv, p + 4);
      var hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = getU64(dv, p + 8); hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) break;
      var node = { type: type, start: p, end: p + size, hdr: hdr, children: null };
      if (CONTAINERS[type]) node.children = parseBoxes(dv, p + hdr, p + size);
      out.push(node);
      p += size;
    }
    return out;
  }

  function findChild(node, type) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].type === type) return kids[i];
    return null;
  }

  function findPath(node, path) {
    var cur = node;
    for (var i = 0; i < path.length && cur; i++) cur = findChild(cur, path[i]);
    return cur;
  }

  // ── sample tables ─────────────────────────────────────────────────────────

  // Expands the five interlocking tables in `stbl` into flat per-sample arrays.
  // Every one of them is a different compression of the same list, and they only
  // agree with each other when read together — stsc says how many samples are in
  // each chunk, stco says where each chunk starts, stsz says how long each sample
  // is, and only walking all three in step gives a sample its byte offset.
  function readSampleTable(dv, stbl) {
    var t = {};

    var stts = findChild(stbl, 'stts');
    if (!stts) return null;
    var p = stts.start + stts.hdr + 4;
    var n = dv.getUint32(p); p += 4;
    var total = 0, i, j, cnt, val;
    for (i = 0; i < n; i++) total += dv.getUint32(p + i * 8);
    if (!total) return null;

    var delta = new Float64Array(total), dts = new Float64Array(total);
    var k = 0, acc = 0;
    for (i = 0; i < n; i++) {
      cnt = dv.getUint32(p + i * 8); val = dv.getUint32(p + i * 8 + 4);
      for (j = 0; j < cnt && k < total; j++) { dts[k] = acc; delta[k] = val; acc += val; k++; }
    }
    t.n = total; t.dts = dts; t.delta = delta; t.mediaDuration = acc;

    // ctts — composition offsets, present whenever the codec reorders frames
    // (B-frames). Version 1 makes them signed, which is how a muxer expresses a
    // negative shift alongside an edit list.
    var ctts = findChild(stbl, 'ctts');
    if (ctts) {
      var cver = dv.getUint8(ctts.start + ctts.hdr);
      t.cttsVersion = cver;
      p = ctts.start + ctts.hdr + 4;
      n = dv.getUint32(p); p += 4;
      var cto = new Float64Array(total); k = 0;
      for (i = 0; i < n && k < total; i++) {
        cnt = dv.getUint32(p + i * 8);
        val = cver === 1 ? dv.getInt32(p + i * 8 + 4) : dv.getUint32(p + i * 8 + 4);
        for (j = 0; j < cnt && k < total; j++) cto[k++] = val;
      }
      t.cto = cto;
    } else {
      t.cto = null;
    }

    // stss lists the sync samples. Its absence means *every* sample is a sync
    // sample, which is the normal case for audio — not "no keyframes".
    var stss = findChild(stbl, 'stss');
    if (stss) {
      p = stss.start + stss.hdr + 4;
      n = dv.getUint32(p); p += 4;
      var sync = new Uint8Array(total);
      for (i = 0; i < n; i++) {
        var s = dv.getUint32(p + i * 4) - 1;
        if (s >= 0 && s < total) sync[s] = 1;
      }
      t.sync = sync;
    } else {
      t.sync = null;
    }

    var size = new Float64Array(total);
    var stsz = findChild(stbl, 'stsz');
    if (stsz) {
      p = stsz.start + stsz.hdr + 4;
      var uniform = dv.getUint32(p); p += 4;
      var count = dv.getUint32(p); p += 4;
      if (uniform) { for (i = 0; i < total; i++) size[i] = uniform; }
      else { for (i = 0; i < total && i < count; i++) size[i] = dv.getUint32(p + i * 4); }
    } else {
      var stz2 = findChild(stbl, 'stz2');
      if (!stz2) return null;
      p = stz2.start + stz2.hdr + 4;
      var field = dv.getUint8(p + 3); p += 4;
      p += 4; // sample_count
      for (i = 0; i < total; i++) {
        if (field === 16) size[i] = dv.getUint16(p + i * 2);
        else if (field === 8) size[i] = dv.getUint8(p + i);
        else if (field === 4) { var b = dv.getUint8(p + (i >> 1)); size[i] = (i & 1) ? (b & 15) : (b >> 4); }
        else return null;
      }
    }
    t.size = size;

    var stco = findChild(stbl, 'stco'), co64 = findChild(stbl, 'co64');
    var src = stco || co64;
    if (!src) return null;
    p = src.start + src.hdr + 4;
    var nchunk = dv.getUint32(p); p += 4;
    var chunkOff = new Float64Array(nchunk);
    for (i = 0; i < nchunk; i++) chunkOff[i] = stco ? dv.getUint32(p + i * 4) : getU64(dv, p + i * 8);

    var stsc = findChild(stbl, 'stsc');
    if (!stsc) return null;
    p = stsc.start + stsc.hdr + 4;
    var nsc = dv.getUint32(p); p += 4;

    // Walk chunk by chunk, laying samples down inside each. This is the only
    // place the byte offsets come from; there is no per-sample offset table.
    var off = new Float64Array(total), sdi = new Uint16Array(total);
    var si = 0, ci = 0;
    for (i = 0; i < nsc && si < total; i++) {
      var first = dv.getUint32(p + i * 12) - 1;
      var per = dv.getUint32(p + i * 12 + 4);
      var desc = dv.getUint32(p + i * 12 + 8);
      var last = (i + 1 < nsc) ? dv.getUint32(p + (i + 1) * 12) - 1 : nchunk;
      for (ci = first; ci < last && si < total; ci++) {
        if (ci >= nchunk) break;
        var at = chunkOff[ci];
        for (j = 0; j < per && si < total; j++) { off[si] = at; sdi[si] = desc; at += size[si]; si++; }
      }
    }
    if (si < total) t.n = total = si; // truncated table: trust what was described
    t.off = off; t.sdi = sdi;
    return t;
  }

  // How far into the media timeline the track's presentation actually starts.
  // ffmpeg puts the AAC priming delay here for audio and the composition shift
  // for video, so a media time read without it is off by a frame or two — which
  // is exactly the error that shows up as lip-sync drift.
  function editOffset(dv, trak) {
    var elst = findPath(trak, ['edts', 'elst']);
    if (!elst) return 0;
    var ver = dv.getUint8(elst.start + elst.hdr);
    var n = dv.getUint32(elst.start + elst.hdr + 4);
    var p = elst.start + elst.hdr + 8;
    for (var i = 0; i < n; i++) {
      var mt = ver === 1 ? getU64(dv, p + 8) : dv.getInt32(p + 4);
      if (ver === 1 && dv.getUint32(p + 8) === 0xFFFFFFFF) mt = -1; // empty edit
      p += (ver === 1 ? 16 : 8) + 4;
      if (mt >= 0) return mt;
    }
    return 0;
  }

  // ── network ───────────────────────────────────────────────────────────────

  async function rangeGet(url, start, endInclusive, signal) {
    var resp = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + endInclusive }, signal: signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    // A 200 means Range was ignored and the body is the whole file — on a 40 GB
    // source that would buffer until the tab dies. Drop it on the floor.
    if (resp.status !== 206) {
      if (resp.body) { try { resp.body.cancel(); } catch (_) {} }
      throw new Error('服务器未支持分段读取');
    }
    var cr = resp.headers.get('Content-Range') || '';
    var total = Number(cr.split('/')[1]) || 0;
    var buf = await resp.arrayBuffer();
    return { buf: buf, total: total };
  }

  // ── source ────────────────────────────────────────────────────────────────

  function declined(reason) { return { ok: false, reason: reason }; }

  var cache = new Map();

  function open(url, signal) {
    var hit = cache.get(url);
    if (hit) return hit;
    var p = openUncached(url, signal).catch(function (err) {
      cache.delete(url);
      return declined(err && err.name === 'AbortError' ? '已取消' : (err.message || '读取失败'));
    });
    cache.set(url, p);
    return p;
  }

  async function openUncached(url, signal) {
    var pos = 0, total = Infinity, moov = null, ftypRange = null, guard = 0;
    while (pos < total && guard++ < 64) {
      var head = await rangeGet(url, pos, pos + 15, signal);
      if (head.total) total = head.total;
      if (head.buf.byteLength < 8) break;
      var dv = new DataView(head.buf);
      var size = dv.getUint32(0);
      var type = str4(dv, 4);
      if (size === 1) {
        if (head.buf.byteLength < 16) break;
        size = getU64(dv, 8);
      } else if (size === 0) {
        size = total - pos;
      }
      if (pos === 0 && type !== 'ftyp') return declined('不是 MP4 文件');
      if (type === 'ftyp') ftypRange = { start: pos, size: size };
      if (type === 'moov') { moov = { start: pos, size: size }; break; }
      if (size < 8) break;
      pos += size;
    }
    if (!moov) return declined('未找到 moov（文件可能不完整）');
    if (moov.size > MAX_MOOV) return declined('索引过大（' + (moov.size / 1048576).toFixed(0) + ' MB）');

    var ftypBuf = ftypRange
      ? new Uint8Array((await rangeGet(url, ftypRange.start, ftypRange.start + ftypRange.size - 1, signal)).buf)
      : box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32])]);

    var moovBuf = (await rangeGet(url, moov.start, moov.start + moov.size - 1, signal)).buf;
    var mdv = new DataView(moovBuf);
    var tree = parseBoxes(mdv, 0, moovBuf.byteLength)[0];
    if (!tree || tree.type !== 'moov') return declined('moov 解析失败');
    // mvex means the samples live in moof boxes further down the file and moov
    // carries only defaults — a different format that this reader cannot slice.
    if (findChild(tree, 'mvex')) return declined('分片 MP4（fMP4）');

    var mvhd = findChild(tree, 'mvhd');
    if (!mvhd) return declined('缺少 mvhd');
    var mver = mdv.getUint8(mvhd.start + mvhd.hdr);
    var movieTimescale = mdv.getUint32(mvhd.start + mvhd.hdr + (mver === 1 ? 20 : 12)) || 1000;

    var tracks = [], duration = 0;
    var kids = tree.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].type !== 'trak') continue;
      var trak = kids[i];
      var mdhd = findPath(trak, ['mdia', 'mdhd']);
      var hdlr = findPath(trak, ['mdia', 'hdlr']);
      var stbl = findPath(trak, ['mdia', 'minf', 'stbl']);
      if (!mdhd || !hdlr || !stbl) continue;
      var hver = mdv.getUint8(mdhd.start + mdhd.hdr);
      var timescale = mdv.getUint32(mdhd.start + mdhd.hdr + (hver === 1 ? 20 : 12)) || 1000;
      var handler = str4(mdv, hdlr.start + hdlr.hdr + 8);
      if (handler !== 'vide' && handler !== 'soun') continue;
      var tab = readSampleTable(mdv, stbl);
      if (!tab) continue;
      var stsd = findChild(stbl, 'stsd');
      var codec = '';
      if (stsd && stsd.end - stsd.start > 24) codec = str4(mdv, stsd.start + stsd.hdr + 12);
      tab.node = trak; tab.stbl = stbl; tab.handler = handler;
      tab.timescale = timescale; tab.codec = codec;
      tab.moff = editOffset(mdv, trak);
      duration = Math.max(duration, tab.mediaDuration / timescale);
      tracks.push(tab);
    }
    if (!tracks.length) return declined('未找到可用轨道');

    var video = null;
    for (i = 0; i < tracks.length; i++) if (tracks[i].handler === 'vide') { video = tracks[i]; break; }

    return {
      ok: true, url: url, totalSize: total, ftyp: ftypBuf, moovDv: mdv, moovTree: tree,
      movieTimescale: movieTimescale, duration: duration, tracks: tracks, videoTrack: video,
      hasVideo: !!video,
      codecs: tracks.map(function (t) { return t.codec; }).filter(Boolean)
    };
  }

  // ── selection ─────────────────────────────────────────────────────────────

  // Last sample whose decode time is <= `at` (in the track's own timescale).
  function lastAtOrBefore(t, at) {
    var lo = 0, hi = t.n - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (t.dts[mid] <= at) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  function plan(src, start, end) {
    if (!src || !src.ok) return declined(src ? src.reason : '未就绪');
    if (!(end > start)) return declined('结束时间必须大于开始时间');

    var t0 = start, i;
    var v = src.videoTrack;
    if (v) {
      // Snap back to the last sync sample, and report its *presentation* time —
      // that is what the viewer sees first, what `actualStart` shows on the
      // button, and what goes into the ffmpeg command beside it. Feeding the
      // decode time here instead would make the two paths disagree by the
      // composition offset on any file with B-frames.
      var idx = lastAtOrBefore(v, start * v.timescale + v.moff);
      if (v.sync) while (idx > 0 && !v.sync[idx]) idx--;
      t0 = (v.dts[idx] + (v.cto ? v.cto[idx] : 0) - v.moff) / v.timescale;
    }

    var sel = [], bytes = 0, samples = 0, actualEnd = t0;
    for (i = 0; i < src.tracks.length; i++) {
      var t = src.tracks[i];
      // Every track starts from the same instant `t0`, which the video track
      // already snapped to a keyframe. Audio has no such constraint, so it takes
      // the sample covering t0 — whatever fraction of a frame that overshoots is
      // trimmed exactly by the edit list below.
      var first = lastAtOrBefore(t, t0 * t.timescale + t.moff);
      if (t === v && t.sync) while (first > 0 && !t.sync[first]) first--;
      var last = lastAtOrBefore(t, end * t.timescale + t.moff);
      if (last < first) last = first;
      // `lastAtOrBefore` lands on the sample that *starts* at or before `end`;
      // if it starts exactly there it is outside the window.
      while (last > first && (t.dts[last] - t.moff) / t.timescale >= end) last--;
      var n = last - first + 1, sum = 0;
      for (var s = first; s <= last; s++) sum += t.size[s];
      bytes += sum; samples += n;
      actualEnd = Math.max(actualEnd, (t.dts[last] + t.delta[last] - t.moff) / t.timescale);
      // M ≥ 0 always: the first kept sample presents at or before t0, so
      // t0*ts + moff ≥ dts[first]. That keeps the emitted elst on version 0.
      var mediaTime = Math.round(t.moff + t0 * t.timescale - t.dts[first]);
      sel.push({ track: t, first: first, last: last, bytes: sum, mediaTime: Math.max(0, mediaTime) });
    }

    if (bytes > MAX_CLIP_BYTES) {
      return declined('片段约 ' + (bytes / 1073741824).toFixed(1) + ' GB，超出浏览器内存限制');
    }

    // What we have to pull off the network: the merged runs, gaps included.
    var runs = mergeRuns(sel);
    var fetched = 0;
    for (i = 0; i < runs.length; i++) fetched += runs[i].end - runs[i].start + 1;

    return {
      ok: true, src: src, sel: sel, runs: runs,
      start: start, end: end, actualStart: t0, actualEnd: actualEnd,
      bytes: bytes, fetchBytes: fetched, samples: samples,
      snapped: t0 < start - 0.05,
      ext: src.hasVideo ? '.mp4' : '.m4a'
    };
  }

  // Per-track sample ranges are contiguous only in a well-interleaved file, and
  // a global min..max span would swallow the whole file when a muxer parks all
  // the audio at one end. Merge from the actual sample offsets instead, and only
  // bridge holes small enough that the wasted bytes beat another round trip.
  function mergeRuns(sel) {
    var raw = [], i, j;
    for (i = 0; i < sel.length; i++) {
      var t = sel[i].track, cur = null;
      for (j = sel[i].first; j <= sel[i].last; j++) {
        var a = t.off[j], b = a + t.size[j] - 1;
        if (cur && a <= cur.end + 1) { if (b > cur.end) cur.end = b; }
        else { cur = { start: a, end: b }; raw.push(cur); }
      }
    }
    raw.sort(function (x, y) { return x.start - y.start; });
    var out = [];
    for (i = 0; i < raw.length; i++) {
      var last = out[out.length - 1];
      if (last && raw[i].start <= last.end + 1 + GAP_TOLERANCE) {
        if (raw[i].end > last.end) last.end = raw[i].end;
      } else {
        out.push({ start: raw[i].start, end: raw[i].end });
      }
    }
    return out;
  }

  // ── output layout ─────────────────────────────────────────────────────────

  // Interleave the kept samples into ~CHUNK_SECONDS chunks on a shared timeline
  // so a player never has to seek far between audio and video. Chunks also break
  // on a sample-description change, because stsc carries one index per chunk.
  function buildChunks(p) {
    var lanes = p.sel.map(function (s) {
      return { s: s, t: s.track, cursor: s.first, base: s.track.dts[s.first] };
    });
    var chunks = [], t = 0, guard = 0;
    for (;;) {
      var any = false;
      t += CHUNK_SECONDS;
      for (var i = 0; i < lanes.length; i++) {
        var L = lanes[i];
        if (L.cursor > L.s.last) continue;
        any = true;
        var limit = L.base + t * L.t.timescale;
        var from = L.cursor, sdi = L.t.sdi[from];
        while (L.cursor <= L.s.last && L.t.dts[L.cursor] < limit && L.t.sdi[L.cursor] === sdi) L.cursor++;
        if (L.cursor === from) L.cursor++; // always make progress
        if (L.cursor > L.s.last + 1) L.cursor = L.s.last + 1;
        chunks.push({ lane: i, track: L.t, first: from, count: L.cursor - from, sdi: sdi });
      }
      if (!any || guard++ > 4000000) break;
    }
    return chunks;
  }

  function fullBox(type, version, flags, payload) {
    var head = new Uint8Array(4);
    head[0] = version; head[1] = (flags >> 16) & 255; head[2] = (flags >> 8) & 255; head[3] = flags & 255;
    return box(type, [head, payload]);
  }

  function rleTable(type, pairs) {
    var buf = new Uint8Array(4 + pairs.length * 8);
    var dv = new DataView(buf.buffer);
    dv.setUint32(0, pairs.length);
    for (var i = 0; i < pairs.length; i++) {
      dv.setUint32(4 + i * 8, pairs[i][0]);
      dv.setInt32(4 + i * 8 + 4, pairs[i][1]);
    }
    return fullBox(type, 0, 0, buf);
  }

  // Builds the six sample tables for one track's slice. `chunkOffsets` is filled
  // in later — its byte position is handed back so the caller can patch real
  // offsets once the moov's own length (and therefore mdat's start) is known.
  function buildStbl(src, s, chunks, laneIndex, use64) {
    var t = s.track, i, j;
    var n = s.last - s.first + 1;

    var stts = [], prev = -1, run = 0;
    for (i = s.first; i <= s.last; i++) {
      var d = t.delta[i];
      if (d === prev) run++;
      else { if (run) stts.push([run, prev]); prev = d; run = 1; }
    }
    if (run) stts.push([run, prev]);

    var parts = [rleTable('stts', stts)];

    if (t.cto) {
      // Verbatim. The edit list's media_time is derived assuming these offsets
      // are untouched; normalising them here as well would trim the composition
      // shift twice and pull the video ahead of the audio by exactly as much as
      // leaving the edit list out pushed it behind.
      var ctts = []; prev = null; run = 0;
      for (i = s.first; i <= s.last; i++) {
        var c = t.cto[i];
        if (c === prev) run++;
        else { if (run) ctts.push([run, prev]); prev = c; run = 1; }
      }
      if (run) ctts.push([run, prev]);
      parts.push(rleTable('ctts', ctts));
    }

    if (t.sync) {
      var syncs = [];
      for (i = s.first; i <= s.last; i++) if (t.sync[i]) syncs.push(i - s.first + 1);
      var sbuf = new Uint8Array(4 + syncs.length * 4);
      var sdv = new DataView(sbuf.buffer);
      sdv.setUint32(0, syncs.length);
      for (i = 0; i < syncs.length; i++) sdv.setUint32(4 + i * 4, syncs[i]);
      parts.push(fullBox('stss', 0, 0, sbuf));
    }

    var mine = [];
    for (i = 0; i < chunks.length; i++) if (chunks[i].lane === laneIndex) mine.push(chunks[i]);

    var stsc = [];
    for (i = 0; i < mine.length; i++) {
      var lastE = stsc[stsc.length - 1];
      if (!lastE || lastE[1] !== mine[i].count || lastE[2] !== mine[i].sdi) stsc.push([i + 1, mine[i].count, mine[i].sdi]);
    }
    var cbuf = new Uint8Array(4 + stsc.length * 12);
    var cdv = new DataView(cbuf.buffer);
    cdv.setUint32(0, stsc.length);
    for (i = 0; i < stsc.length; i++) {
      cdv.setUint32(4 + i * 12, stsc[i][0]);
      cdv.setUint32(4 + i * 12 + 4, stsc[i][1]);
      cdv.setUint32(4 + i * 12 + 8, stsc[i][2]);
    }
    parts.push(fullBox('stsc', 0, 0, cbuf));

    var zbuf = new Uint8Array(8 + n * 4);
    var zdv = new DataView(zbuf.buffer);
    zdv.setUint32(0, 0); zdv.setUint32(4, n);
    for (i = 0, j = s.first; j <= s.last; i++, j++) zdv.setUint32(8 + i * 4, t.size[j]);
    parts.push(fullBox('stsz', 0, 0, zbuf));

    var width = use64 ? 8 : 4;
    var obuf = new Uint8Array(4 + mine.length * width);
    new DataView(obuf.buffer).setUint32(0, mine.length);
    var offBox = fullBox(use64 ? 'co64' : 'stco', 0, 0, obuf);
    parts.push(offBox);

    return { parts: parts, offBox: offBox, offStart: 8 + 4 + 4, chunkList: mine, width: width };
  }

  // Rebuild a box from the parsed tree, replacing what has to change and copying
  // everything else verbatim — stsd with its codec configuration, colr, pasp,
  // and whatever else the source muxer wrote. Verbatim is the whole point: it is
  // why this file never mentions a codec.
  function rebuild(ctx, node) {
    var dv = ctx.dv, raw = new Uint8Array(dv.buffer, dv.byteOffset);
    var i;

    if (node.type === 'stbl') {
      var keep = [];
      var kids = node.children || [];
      for (i = 0; i < kids.length; i++) {
        if (!STBL_REBUILT[kids[i].type]) keep.push(raw.subarray(kids[i].start, kids[i].end));
      }
      var built = ctx.stblFor(node);
      return box('stbl', keep.concat(built.parts));
    }

    if (CONTAINERS[node.type]) {
      var parts = [], k = node.children || [];
      for (i = 0; i < k.length; i++) {
        // The source's own edts refers to a media timeline that no longer has
        // the frames it points at. It is replaced, not carried over — its offset
        // was already folded into the new media_time back in plan().
        if (k[i].type === 'edts') continue;
        if (k[i].type === 'mvex') continue;
        if (node.type === 'moov' && k[i].type === 'trak' && !ctx.keepTrak(k[i])) continue;
        if (CONTAINERS[k[i].type]) parts.push(rebuild(ctx, k[i]));
        else parts.push(ctx.leaf(k[i], raw));
        // Conventional position: straight after tkhd, before mdia.
        if (node.type === 'trak' && k[i].type === 'tkhd') {
          var ed = ctx.edtsFor();
          if (ed) parts.push(ed);
        }
      }
      return box(node.type, parts);
    }

    return ctx.leaf(node, raw);
  }

  function patchedHeader(node, raw, dv, durations) {
    var copy = raw.slice(node.start, node.end);
    var cdv = new DataView(copy.buffer);
    var p = node.hdr;
    var ver = cdv.getUint8(p);
    if (node.type === 'mvhd') {
      if (ver === 1) setU64(cdv, p + 24, durations.movie); else cdv.setUint32(p + 16, Math.min(durations.movie, U32_MAX - 1));
    } else if (node.type === 'tkhd') {
      if (ver === 1) setU64(cdv, p + 28, durations.movie); else cdv.setUint32(p + 20, Math.min(durations.movie, U32_MAX - 1));
    } else if (node.type === 'mdhd') {
      if (ver === 1) setU64(cdv, p + 24, durations.media); else cdv.setUint32(p + 16, Math.min(durations.media, U32_MAX - 1));
    }
    return copy;
  }

  function buildMoov(p, use64) {
    var src = p.src;
    var chunks = buildChunks(p);
    var byTrak = new Map();
    var built = [];
    for (var i = 0; i < p.sel.length; i++) {
      var b = buildStbl(src, p.sel[i], chunks, i, use64);
      built.push(b);
      byTrak.set(p.sel[i].track.stbl, b);
    }

    var movieDurSec = p.actualEnd - p.actualStart;
    var curTrack = null, curSel = null;
    var ctx = {
      dv: src.moovDv,
      keepTrak: function (trak) {
        for (var j = 0; j < p.sel.length; j++) {
          if (p.sel[j].track.node === trak) { curSel = p.sel[j]; curTrack = p.sel[j].track; return true; }
        }
        return false;
      },
      edtsFor: function () {
        if (!curSel) return null;
        var buf = new Uint8Array(4 + 12);
        var edv = new DataView(buf.buffer);
        edv.setUint32(0, 1);
        edv.setUint32(4, Math.max(0, Math.round(movieDurSec * src.movieTimescale)));
        edv.setInt32(8, curSel.mediaTime);
        edv.setInt32(12, 0x00010000); // rate 1.0, 16.16 fixed point
        return box('edts', [fullBox('elst', 0, 0, buf)]);
      },
      stblFor: function (stbl) { return byTrak.get(stbl); },
      leaf: function (node, raw) {
        if (node.type === 'mvhd' || node.type === 'tkhd' || node.type === 'mdhd') {
          var ts = node.type === 'mdhd' ? (curTrack ? curTrack.timescale : src.movieTimescale) : src.movieTimescale;
          return patchedHeader(node, raw, src.moovDv, {
            movie: Math.round(movieDurSec * src.movieTimescale),
            media: Math.round(movieDurSec * ts)
          });
        }
        return raw.subarray(node.start, node.end);
      }
    };

    // `keepTrak` runs before the trak's own children, so curTrack is the right
    // one by the time mdhd is reached. Order is guaranteed by rebuild()'s walk.
    var moov = rebuild(ctx, src.moovTree);
    return { moov: moov, built: built, chunks: chunks };
  }

  // ── the clip itself ───────────────────────────────────────────────────────

  async function render(p, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var signal = opts.signal;
    var src = p.src, i;

    // Layout is decided before any media is fetched. The only unknown is whether
    // the chunk offset table needs 64-bit entries, and that depends on the moov's
    // own size — so build once, measure, and rebuild only if the guess was wrong.
    var use64 = (p.bytes + 16 * 1024 * 1024) >= U32_MAX;
    var layout = buildMoov(p, use64);
    var mdatPayload = p.bytes;
    var mdatHdr = (mdatPayload + 8) >= U32_MAX ? 16 : 8;
    var mdatStart = src.ftyp.length + layout.moov.length + mdatHdr;
    if (!use64 && mdatStart + mdatPayload >= U32_MAX) {
      use64 = true;
      layout = buildMoov(p, true);
      mdatStart = src.ftyp.length + layout.moov.length + mdatHdr;
    }

    // Fill in the real chunk offsets. The boxes were built at their final size,
    // so patching in place cannot move anything.
    var rel = 0;
    var perChunkOffset = new Map();
    for (i = 0; i < layout.chunks.length; i++) {
      var ch = layout.chunks[i];
      perChunkOffset.set(ch, mdatStart + rel);
      for (var s = ch.first; s < ch.first + ch.count; s++) rel += ch.track.size[s];
    }
    spliceOffsets(layout, perChunkOffset);

    // Fetch the media. One request per merged run, sequential so a huge clip
    // does not open a dozen concurrent multi-hundred-MB reads.
    var got = [], done = 0;
    for (i = 0; i < p.runs.length; i++) {
      var r = p.runs[i];
      onProgress({ phase: 'fetch', loaded: done, total: p.fetchBytes });
      var res = await rangeGet(src.url, r.start, r.end, signal);
      got.push({ start: r.start, end: r.end, u8: new Uint8Array(res.buf) });
      done += r.end - r.start + 1;
      onProgress({ phase: 'fetch', loaded: done, total: p.fetchBytes });
    }

    function bufFor(off) {
      var lo = 0, hi = got.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (off < got[mid].start) hi = mid - 1;
        else if (off > got[mid].end) lo = mid + 1;
        else return got[mid];
      }
      return null;
    }

    onProgress({ phase: 'mux', loaded: 0, total: p.bytes });

    // Emit as a list of subarrays rather than one big allocation: Blob can back
    // the result with disk, so peak memory stays at roughly the clip size
    // instead of double. Consecutive samples usually sit next to each other in
    // the source, so the runs coalesce and the part count stays in the thousands.
    var parts = [src.ftyp, layout.moov];
    var mh = new Uint8Array(mdatHdr);
    var mdv2 = new DataView(mh.buffer);
    if (mdatHdr === 16) {
      mdv2.setUint32(0, 1);
      mh[4] = 109; mh[5] = 100; mh[6] = 97; mh[7] = 116;
      setU64(mdv2, 8, mdatPayload + 16);
    } else {
      mdv2.setUint32(0, mdatPayload + 8);
      mh[4] = 109; mh[5] = 100; mh[6] = 97; mh[7] = 116;
    }
    parts.push(mh);

    var runBuf = null, runS = 0, runE = 0, written = 0, tick = 0;
    function flush() { if (runBuf) parts.push(runBuf.u8.subarray(runS, runE)); runBuf = null; }
    for (i = 0; i < layout.chunks.length; i++) {
      var chk = layout.chunks[i];
      for (var k = chk.first; k < chk.first + chk.count; k++) {
        var off = chk.track.off[k], len = chk.track.size[k];
        var buf = bufFor(off);
        if (!buf) { flush(); throw new Error('样本 ' + k + ' 超出已下载范围'); }
        var a = off - buf.start;
        if (runBuf === buf && runE === a) { runE = a + len; }
        else { flush(); runBuf = buf; runS = a; runE = a + len; }
        written += len;
        if ((tick++ & 1023) === 0) onProgress({ phase: 'mux', loaded: written, total: p.bytes });
      }
    }
    flush();
    onProgress({ phase: 'mux', loaded: p.bytes, total: p.bytes });

    return new Blob(parts, { type: src.hasVideo ? 'video/mp4' : 'audio/mp4' });
  }

  // buildStbl hands back the offset box it created, but box() copies its parts
  // into the parent, so writing into that original changes nothing. Rather than
  // thread byte positions through four levels of container, rebuild the moov
  // once more now that every offset is known — the tables are already sized, so
  // the second pass produces an identical length.
  function spliceOffsets(layout, perChunkOffset) {
    for (var i = 0; i < layout.built.length; i++) {
      var b = layout.built[i];
      b.resolved = [];
      for (var c = 0; c < b.chunkList.length; c++) b.resolved.push(perChunkOffset.get(b.chunkList[c]));
    }
    var moov = layout.moov;
    // Walk the finished moov and write each stco/co64 payload in order. Track
    // order in the output matches p.sel order, which is the order `built` is in.
    var dv = new DataView(moov.buffer, moov.byteOffset, moov.length);
    var seen = 0;
    (function walk(start, end) {
      var p2 = start;
      while (p2 + 8 <= end) {
        var size = dv.getUint32(p2);
        var type = str4(dv, p2 + 4);
        if (size < 8 || p2 + size > end) break;
        if (type === 'stco' || type === 'co64') {
          var b2 = layout.built[seen++];
          if (b2) {
            var q = p2 + 8 + 4 + 4;
            for (var c2 = 0; c2 < b2.resolved.length; c2++) {
              if (type === 'co64') setU64(dv, q + c2 * 8, b2.resolved[c2]);
              else dv.setUint32(q + c2 * 4, b2.resolved[c2]);
            }
          }
        } else if (CONTAINERS[type]) {
          walk(p2 + 8, p2 + size);
        }
        p2 += size;
      }
    })(8, moov.length);
    return layout;
  }

  // ── download / zip ────────────────────────────────────────────────────────

  // Clip names are user text and land straight in a filename. Strip only the
  // path separators and the characters Windows refuses — spaces, hyphens and
  // CJK all survive, because mangling them makes the download unrecognisable.
  function safeName(name, ext) {
    var s = String(name || 'clip').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').trim();
    if (!s) s = 'clip';
    if (s.length > 120) s = s.slice(0, 120);
    return s.toLowerCase().endsWith(ext) ? s : s + ext;
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    // `a.download` takes a UTF-16 string straight, so Chinese names need none of
    // the RFC 5987 dance that Content-Disposition does on the server side.
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  async function crc32(blob) {
    var c = 0xFFFFFFFF;
    var reader = blob.stream().getReader();
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      var b = r.value;
      for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Store-only ZIP (method 0): the payload is already compressed video, so
  // deflate would spend CPU to gain nothing. One file beats N downloads, which
  // browsers block after the first without a prompt.
  // MS-DOS date/time: yyyy-1980 in bits 15-9, month 8-5, day 4-0; then hours
  // 15-11, minutes 10-5, two-second units 4-0. Wrong values here surface as an
  // absurd modification date in every extractor.
  function dosTime(d) {
    return {
      date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    };
  }

  async function zip(entries, onProgress) {
    var enc = new TextEncoder();
    var stamp = dosTime(new Date());
    var parts = [], central = [], offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (onProgress) onProgress({ phase: 'zip', loaded: i, total: entries.length });
      var nameBytes = enc.encode(e.name);
      var crc = await crc32(e.blob);
      var size = e.blob.size;
      if (size >= U32_MAX) throw new Error('单个片段超过 4 GB，ZIP 无法容纳');
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // bit 11: the name is UTF-8
      dv.setUint16(8, 0, true);      // stored
      dv.setUint16(10, stamp.time, true); dv.setUint16(12, stamp.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);
      parts.push(lh, e.blob);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cd = new DataView(ch.buffer);
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, stamp.time, true); cd.setUint16(14, stamp.date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true); cd.setUint32(24, size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);
      offset += lh.length + size;
      if (offset >= U32_MAX) throw new Error('打包总大小超过 4 GB，请分批下载');
    }
    var cdSize = 0;
    for (i = 0; i < central.length; i++) cdSize += central[i].length;
    var eocd = new Uint8Array(22);
    var edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  global.MP4Clip = {
    open: open,
    plan: plan,
    render: render,
    zip: zip,
    saveBlob: saveBlob,
    safeName: safeName,
    forget: function (url) { cache.delete(url); }
  };
})(window);
